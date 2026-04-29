import {
	TinybirdQueryError,
	type TinybirdQueryRequest,
	TinybirdQueryResponse,
	TinybirdQuotaExceededError,
} from "@maple/domain/http"
import type { OrgId } from "@maple/domain"
import { createClient as createClickHouseClient } from "@clickhouse/client-web"
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
	url: string
	username: string
	password: string
	database: string
	expiresAt: number
}

interface SqlClientConfig {
	readonly url: string
	readonly username: string
	readonly password: string
	readonly database: string
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

const createClient = (config: SqlClientConfig): SqlClient => {
	const client = createClickHouseClient({
		url: config.url,
		username: config.username,
		password: config.password,
		database: config.database,
	})
	return {
		sql: async (sql: string) => {
			const resultSet = await client.query({
				query: sql,
				format: "JSONEachRow",
			})
			const data = await resultSet.json<Record<string, unknown>>()
			return { data }
		},
	}
}

let clickHouseClientFactory: typeof createClient = createClient

const normalizeSqlForClickHouseClient = (sql: string): string =>
	sql
		.replace(/;\s*$/, "")
		.replace(/\s+FORMAT\s+(?:JSONEachRow|JSON)\s*$/i, "")
		.replace(/;\s*$/, "")

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
				cleaned = cleaned
					.replace(/<[^>]+>/g, " ")
					.replace(/\s+/g, " ")
					.trim()
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

			const getCachedOrCreateClient = (orgId: OrgId | "__managed__", config: SqlClientConfig) => {
				const now = Date.now()
				const cached = clientCache.get(orgId)
				if (
					cached &&
					cached.url === config.url &&
					cached.username === config.username &&
					cached.password === config.password &&
					cached.database === config.database &&
					cached.expiresAt > now
				) {
					return cached.client
				}
				const client = clickHouseClientFactory(config)
				clientCache.set(orgId, { client, ...config, expiresAt: now + CLIENT_CACHE_TTL_MS })
				return client
			}

			const resolveTinybirdHostToken = Effect.fn("TinybirdService.resolveTinybirdHostToken")(function* (
				tenant: TenantContext,
				label: string,
			) {
				const override = yield* orgTinybirdSettings
					.resolveRuntimeConfig(tenant.orgId)
					.pipe(Effect.mapError((error) => toTinybirdQueryError(label, error)))

				if (Option.isSome(override)) {
					yield* Effect.annotateCurrentSpan("clientSource", "org_override")
					return {
						host: override.value.host,
						token: override.value.token,
						source: "org_override" as const,
					}
				}

				yield* Effect.annotateCurrentSpan("clientSource", "managed")
				return {
					host: env.TINYBIRD_HOST,
					token: Redacted.value(env.TINYBIRD_TOKEN),
					source: "managed" as const,
				}
			})

			const resolveSqlConfig = Effect.fn("TinybirdService.resolveSqlConfig")(function* (
				tenant: TenantContext,
				label: string,
			) {
				const override = yield* orgTinybirdSettings
					.resolveRuntimeConfig(tenant.orgId)
					.pipe(Effect.mapError((error) => toTinybirdQueryError(label, error)))

				if (Option.isSome(override)) {
					yield* Effect.annotateCurrentSpan("clientSource", "org_override")
					return {
						config: {
							url: override.value.host,
							username: env.CLICKHOUSE_USER,
							password: override.value.token,
							database: env.CLICKHOUSE_DATABASE,
						},
						source: "org_override" as const,
					}
				}

				yield* Effect.annotateCurrentSpan("clientSource", "managed")
				return {
					config: {
						url: Option.getOrElse(env.CLICKHOUSE_URL, () => env.TINYBIRD_HOST),
						username: env.CLICKHOUSE_USER,
						password: Option.match(env.CLICKHOUSE_PASSWORD, {
							onNone: () => Redacted.value(env.TINYBIRD_TOKEN),
							onSome: Redacted.value,
						}),
						database: env.CLICKHOUSE_DATABASE,
					},
					source: "managed" as const,
				}
			})

			const resolveClient = Effect.fn("TinybirdService.resolveClient")(function* (
				tenant: TenantContext,
				pipe: string,
			) {
				yield* Effect.annotateCurrentSpan("pipe", pipe)
				yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)

				const resolved = yield* resolveSqlConfig(tenant, pipe)
				const cacheKey = resolved.source === "managed" ? "__managed__" : tenant.orgId
				return getCachedOrCreateClient(cacheKey, resolved.config)
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
				const sqlForClient = normalizeSqlForClickHouseClient(sql)
				const finalSql = appendSettings(sqlForClient, settings)
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
				const resolved = yield* resolveTinybirdHostToken(tenant, label)
				const ndjson = rows.map((row) => JSON.stringify(row)).join("\n")
				const url = `${resolved.host.replace(/\/$/, "")}/v0/events?name=${encodeURIComponent(datasource)}&wait=false`

				yield* Effect.tryPromise({
					try: async () => {
						const response = await fetch(url, {
							method: "POST",
							headers: {
								"Content-Type": "application/x-ndjson",
								Authorization: `Bearer ${resolved.token}`,
							},
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
	setClientFactory: (factory: typeof createClient) => {
		clickHouseClientFactory = factory
		clientCache.clear()
	},
	reset: () => {
		clickHouseClientFactory = createClient
		clientCache.clear()
	},
}
