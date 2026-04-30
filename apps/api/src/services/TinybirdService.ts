import {
	TinybirdQueryError,
	type TinybirdQueryRequest,
	TinybirdQueryResponse,
	TinybirdQuotaExceededError,
} from "@maple/domain/http"
import type { OrgId } from "@maple/domain"
import { Tinybird } from "@tinybirdco/sdk"
import { Effect, Layer, Option, Redacted, Context } from "effect"
import { Env } from "./Env"
import type { TenantContext } from "./AuthService"
import { OrgTinybirdSettingsService } from "./OrgTinybirdSettingsService"
import { compilePipeQuery } from "./PipeQueryDispatcher"
import {
	appendSettings,
	detectQuotaSetting,
	resolveSettings,
	type QueryProfileName,
	type TinybirdQuerySettings,
} from "./TinybirdQueryProfile"

export type SqlQueryOptions = {
	profile?: QueryProfileName
	settings?: TinybirdQuerySettings
}

const CLIENT_CACHE_TTL_MS = 30_000
interface CachedClient {
	client: SqlClient
	signature: string
	expiresAt: number
}

export type TinybirdSqlError = TinybirdQueryError | TinybirdQuotaExceededError

export interface TinybirdServiceShape {
	readonly query: (
		tenant: TenantContext,
		payload: TinybirdQueryRequest,
		options?: SqlQueryOptions,
	) => Effect.Effect<TinybirdQueryResponse, TinybirdSqlError>
	readonly sqlQuery: (
		tenant: TenantContext,
		sql: string,
		options?: SqlQueryOptions,
	) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, TinybirdSqlError>
	readonly ingest: <T>(
		tenant: TenantContext,
		datasource: string,
		rows: ReadonlyArray<T>,
	) => Effect.Effect<void, TinybirdQueryError>
}

const clientCache = new Map<string, CachedClient>()

/** Minimal client interface — only raw SQL execution is needed now. */
interface SqlClient {
	readonly sql: (sql: string) => Promise<{ data: ReadonlyArray<Record<string, unknown>> }>
}

/**
 * Resolved upstream connection. Self-managed deployments using a vanilla
 * ClickHouse instance get a `clickhouse` connection; everything else (managed
 * Tinybird Cloud, BYO Tinybird per-org overrides) gets a `tinybird` connection.
 */
type ResolvedConnection =
	| {
			readonly backend: "tinybird"
			readonly host: string
			readonly token: string
			readonly source: "managed" | "org_override"
	  }
	| {
			readonly backend: "clickhouse"
			readonly url: string
			readonly user: string
			readonly password: string
			readonly database: string
			readonly source: "org_override"
	  }

const signatureOf = (resolved: ResolvedConnection): string =>
	resolved.backend === "tinybird"
		? `tb:${resolved.host}:${resolved.token}`
		: `ch:${resolved.url}:${resolved.user}:${resolved.database}:${resolved.password.length > 0 ? "y" : "n"}`

const createTinybirdClient = (baseUrl: string, token: string): SqlClient => {
	const tb = new Tinybird({
		baseUrl,
		token,
		datasources: {},
		pipes: {},
		devMode: false,
	})
	return { sql: (sql: string) => tb.sql(sql) }
}

const createClickHouseClient = (
	url: string,
	user: string,
	password: string,
	database: string,
): SqlClient => {
	const endpoint = url.replace(/\/$/, "")
	const headers: Record<string, string> = {
		"Content-Type": "text/plain",
		"X-ClickHouse-User": user,
		"X-ClickHouse-Database": database,
	}
	if (password.length > 0) headers["X-ClickHouse-Key"] = password

	return {
		sql: async (sql: string) => {
			const response = await fetch(endpoint, { method: "POST", headers, body: sql })
			const text = await response.text()
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`)
			}
			// `FORMAT JSON` (already appended by the query engine) returns a body shaped
			// `{ meta, data, rows, statistics }` — same `data` field name Tinybird's SDK
			// surfaces, so the rest of TinybirdService treats both backends identically.
			const parsed = JSON.parse(text) as {
				readonly data?: ReadonlyArray<Record<string, unknown>>
			}
			return { data: parsed.data ?? [] }
		},
	}
}

const createClient = (resolved: ResolvedConnection): SqlClient =>
	resolved.backend === "tinybird"
		? tinybirdClientFactory(resolved.host, resolved.token)
		: clickHouseClientFactory(resolved.url, resolved.user, resolved.password, resolved.database)

let tinybirdClientFactory: (baseUrl: string, token: string) => SqlClient = createTinybirdClient
let clickHouseClientFactory: (
	url: string,
	user: string,
	password: string,
	database: string,
) => SqlClient = createClickHouseClient

export class TinybirdService extends Context.Service<TinybirdService, TinybirdServiceShape>()(
	"TinybirdService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const orgTinybirdSettings = yield* OrgTinybirdSettingsService

			const cleanErrorMessage = (raw: string): string => {
				let cleaned = raw
				const htmlIndex = cleaned.search(/<\s*(html|head|body|center|h1|hr|title)\b/i)
				if (htmlIndex >= 0) cleaned = cleaned.slice(0, htmlIndex)
				cleaned = cleaned.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
				if (cleaned.endsWith(":")) cleaned = cleaned.slice(0, -1).trim()
				return cleaned || raw.slice(0, 200)
			}

			const extractUpstreamStatus = (message: string): number | undefined => {
				const match = message.match(/status[:\s]+(\d{3})/i)
				if (match) return Number(match[1])
				return undefined
			}

			const toTinybirdQueryError = (pipe: string, error: unknown) =>
				new TinybirdQueryError({
					message: cleanErrorMessage(
						error instanceof Error ? error.message : "Tinybird query failed",
					),
					pipe,
				})

			const mapTinybirdError = (pipe: string, error: unknown) => {
				const rawMessage = error instanceof Error ? error.message : "Tinybird query failed"
				const message = cleanErrorMessage(rawMessage)
				const setting = detectQuotaSetting(rawMessage)
				if (setting) {
					return new TinybirdQuotaExceededError({ pipe, message, setting })
				}
				const upstreamStatus = extractUpstreamStatus(rawMessage)
				if (upstreamStatus === 401 || upstreamStatus === 403) {
					return new TinybirdQueryError({ pipe, message, category: "auth", upstreamStatus })
				}
				// Any upstream 5xx (502/503/504, Cloudflare 520-530, etc.) is treated
				// as a transient infrastructure failure rather than a user query bug.
				if (upstreamStatus !== undefined && upstreamStatus >= 500 && upstreamStatus < 600) {
					return new TinybirdQueryError({
						pipe,
						message,
						category: "upstream",
						upstreamStatus,
					})
				}
				return new TinybirdQueryError({ pipe, message, category: "query" })
			}

			const getCachedOrCreateClient = (
				orgId: OrgId | "__managed__",
				resolved: ResolvedConnection,
			) => {
				const now = Date.now()
				const signature = signatureOf(resolved)
				const cached = clientCache.get(orgId)
				if (cached && cached.signature === signature && cached.expiresAt > now) {
					return cached.client
				}
				const client = createClient(resolved)
				clientCache.set(orgId, { client, signature, expiresAt: now + CLIENT_CACHE_TTL_MS })
				return client
			}

			const resolveHostToken = Effect.fn("TinybirdService.resolveHostToken")(function* (
				tenant: TenantContext,
				label: string,
			) {
				const override = yield* orgTinybirdSettings
					.resolveRuntimeConfig(tenant.orgId)
					.pipe(Effect.mapError((error) => toTinybirdQueryError(label, error)))

				if (Option.isSome(override)) {
					yield* Effect.annotateCurrentSpan("clientSource", "org_override")
					if (override.value.backend === "clickhouse") {
						yield* Effect.annotateCurrentSpan("backend", "clickhouse")
						return {
							backend: "clickhouse",
							url: override.value.url,
							user: override.value.user,
							password: override.value.password,
							database: override.value.database,
							source: "org_override",
						} satisfies ResolvedConnection
					}
					yield* Effect.annotateCurrentSpan("backend", "tinybird")
					return {
						backend: "tinybird",
						host: override.value.host,
						token: override.value.token,
						source: "org_override",
					} satisfies ResolvedConnection
				}

				yield* Effect.annotateCurrentSpan("clientSource", "managed")
				yield* Effect.annotateCurrentSpan("backend", "tinybird")
				return {
					backend: "tinybird",
					host: env.TINYBIRD_HOST,
					token: Redacted.value(env.TINYBIRD_TOKEN),
					source: "managed",
				} satisfies ResolvedConnection
			})

			const resolveClient = Effect.fn("TinybirdService.resolveClient")(function* (
				tenant: TenantContext,
				pipe: string,
			) {
				yield* Effect.annotateCurrentSpan("pipe", pipe)
				yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)

				const resolved = yield* resolveHostToken(tenant, pipe)
				const cacheKey = resolved.source === "managed" ? "__managed__" : tenant.orgId
				return getCachedOrCreateClient(cacheKey, resolved)
			})

			const truncateSql = (s: string, maxLen = 1000) =>
				s.length > maxLen ? s.slice(0, maxLen) + "...[truncated]" : s

			const executeSql = Effect.fn("TinybirdService.executeSql")(function* (
				tenant: TenantContext,
				sql: string,
				pipe: string,
				options?: SqlQueryOptions,
			) {
				yield* Effect.annotateCurrentSpan("db.system", "clickhouse")
				yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)

				const leftoverParam = sql.match(/__PARAM_(\w+)__/)
				if (leftoverParam) {
					return yield* new TinybirdQueryError({
						pipe,
						message: `Compiled SQL contains unresolved param '${leftoverParam[1]}' — query was built with param.${leftoverParam[1]}() but '${leftoverParam[1]}' was not provided in the runtime params object`,
					})
				}

				const settings = resolveSettings(options)
				const finalSql = appendSettings(sql, settings)
				yield* Effect.annotateCurrentSpan("db.statement", truncateSql(finalSql))
				if (options?.profile) yield* Effect.annotateCurrentSpan("query.profile", options.profile)
				if (settings) yield* Effect.annotateCurrentSpan("ch.settings", JSON.stringify(settings))

				const client = yield* resolveClient(tenant, pipe)
				const result = yield* Effect.tryPromise({
					try: () => client.sql(finalSql),
					catch: (error) => mapTinybirdError(pipe, error),
				}).pipe(
					Effect.tapError((error) =>
						Effect.logError("TinybirdService.executeSql failed", {
							pipe,
							error: String(error),
							message: error.message,
							sql: truncateSql(finalSql),
							profile: options?.profile,
						}),
					),
				)

				yield* Effect.annotateCurrentSpan("result.rowCount", result.data.length)
				return result.data
			})

			const query = Effect.fn("TinybirdService.query")(function* (
				tenant: TenantContext,
				payload: TinybirdQueryRequest,
				options?: SqlQueryOptions,
			) {
				yield* Effect.annotateCurrentSpan("pipe", payload.pipe)
				yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)

				if (!tenant.orgId || tenant.orgId.trim() === "") {
					return yield* new TinybirdQueryError({
						pipe: payload.pipe,
						message: "org_id must not be empty",
					})
				}

				const compiled = compilePipeQuery(payload.pipe, {
					...payload.params,
					org_id: tenant.orgId,
				})

				if (!compiled) {
					return yield* new TinybirdQueryError({
						message: `Unsupported pipe: ${payload.pipe}`,
						pipe: payload.pipe,
					})
				}

				const rows = yield* executeSql(tenant, compiled.sql, payload.pipe, options)

				return new TinybirdQueryResponse({
					data: Array.from(compiled.castRows(rows)),
				})
			})

			const sqlQuery = Effect.fn("TinybirdService.sqlQuery")(function* (
				tenant: TenantContext,
				sql: string,
				options?: SqlQueryOptions,
			) {
				if (!tenant.orgId || tenant.orgId.trim() === "") {
					return yield* new TinybirdQueryError({
						pipe: "sqlQuery",
						message: "org_id must not be empty (sqlQuery)",
					})
				}
				if (!sql.includes("OrgId")) {
					return yield* new TinybirdQueryError({
						pipe: "sqlQuery",
						message: "SQL query must contain OrgId filter (sqlQuery)",
					})
				}
				return yield* executeSql(tenant, sql, "sqlQuery", options)
			})

			const ingest = Effect.fn("TinybirdService.ingest")(function* <T>(
				tenant: TenantContext,
				datasource: string,
				rows: ReadonlyArray<T>,
			) {
				yield* Effect.annotateCurrentSpan("datasource", datasource)
				yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
				yield* Effect.annotateCurrentSpan("rowCount", rows.length)

				if (rows.length === 0) return

				const label = `ingest:${datasource}`
				const resolved = yield* resolveHostToken(tenant, label)
				const ndjson = rows.map((row) => JSON.stringify(row)).join("\n")

				const { url, headers } =
					resolved.backend === "tinybird"
						? {
								url: `${resolved.host.replace(/\/$/, "")}/v0/events?name=${encodeURIComponent(datasource)}&wait=false`,
								headers: {
									"Content-Type": "application/x-ndjson",
									Authorization: `Bearer ${resolved.token}`,
								} as Record<string, string>,
							}
						: (() => {
								// Direct INSERT to ClickHouse using JSONEachRow — same wire format as
								// the NDJSON we already build above. The query string carries the
								// target table; ClickHouse parses each line as one row.
								const ch: Record<string, string> = {
									"Content-Type": "application/x-ndjson",
									"X-ClickHouse-User": resolved.user,
									"X-ClickHouse-Database": resolved.database,
								}
								if (resolved.password.length > 0) ch["X-ClickHouse-Key"] = resolved.password
								return {
									url: `${resolved.url.replace(/\/$/, "")}/?query=${encodeURIComponent(`INSERT INTO ${datasource} FORMAT JSONEachRow`)}`,
									headers: ch,
								}
							})()

				yield* Effect.tryPromise({
					try: async () => {
						const response = await fetch(url, {
							method: "POST",
							headers,
							body: ndjson,
						})
						if (!response.ok) {
							const body = await response.text().catch(() => "")
							throw new Error(
								`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
							)
						}
					},
					catch: (error) => toTinybirdQueryError(label, error),
				}).pipe(
					Effect.tapError((error) =>
						Effect.logError("TinybirdService.ingest failed", {
							datasource,
							rowCount: rows.length,
							backend: resolved.backend,
							error: String(error),
							message: error.message,
						}),
					),
				)
			})

			return {
				query,
				sqlQuery,
				ingest,
			} satisfies TinybirdServiceShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
	static readonly Live = this.layer
	static readonly Default = this.layer

	static readonly query = (
		tenant: TenantContext,
		payload: TinybirdQueryRequest,
		options?: SqlQueryOptions,
	) => this.use((service) => service.query(tenant, payload, options))

	static readonly ingest = <T>(tenant: TenantContext, datasource: string, rows: ReadonlyArray<T>) =>
		this.use((service) => service.ingest(tenant, datasource, rows))
}

export const __testables = {
	setClientFactory: (factory: (baseUrl: string, token: string) => SqlClient) => {
		tinybirdClientFactory = factory
		clientCache.clear()
	},
	setClickHouseClientFactory: (
		factory: (url: string, user: string, password: string, database: string) => SqlClient,
	) => {
		clickHouseClientFactory = factory
		clientCache.clear()
	},
	reset: () => {
		tinybirdClientFactory = createTinybirdClient
		clickHouseClientFactory = createClickHouseClient
		clientCache.clear()
	},
}
