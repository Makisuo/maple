import {
	TinybirdQueryError,
	type TinybirdQueryRequest,
	TinybirdQueryResponse,
	TinybirdQuotaExceededError,
} from "@maple/domain/http"
import type { OrgId } from "@maple/domain"
import { createClient as createClickHouseClient } from "@clickhouse/client-web"
import { Tinybird } from "@tinybirdco/sdk"
import { Clock, Context, Effect, Layer, Option, Redacted, Schedule } from "effect"
import { Env } from "./Env"
import type { TenantContext } from "./AuthService"
import { OrgClickHouseSettingsService } from "./OrgClickHouseSettingsService"
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
	/**
	 * Semantic name for the query (e.g. "errorsByType", "spanHierarchy").
	 * Annotated on the executeSql span as `query.context` so traces can be filtered
	 * and grouped by call site without re-running the SQL.
	 */
	context?: string
}

const CLIENT_CACHE_TTL_MS = 30_000
interface CachedClient {
	client: SqlClient
	cacheKey: string
	expiresAt: number
}

interface ClickHouseSqlClientConfig {
	readonly _tag: "clickhouse"
	readonly url: string
	readonly username: string
	readonly password: string
	readonly database: string
}

interface TinybirdSdkSqlClientConfig {
	readonly _tag: "tinybird"
	readonly host: string
	readonly token: string
}

type SqlClientConfig = ClickHouseSqlClientConfig | TinybirdSdkSqlClientConfig

export type WarehouseSqlError = TinybirdQueryError | TinybirdQuotaExceededError
/**
 * Legacy alias kept so callers that imported `TinybirdSqlError` keep compiling
 * during the rename. Prefer `WarehouseSqlError` in new code.
 */
export type TinybirdSqlError = WarehouseSqlError
type TinybirdQueryErrorCategory =
	| "query"
	| "upstream"
	| "auth"
	| "config"
	| "client"
	| "schema_drift"

export interface WarehouseQueryServiceShape {
	readonly query: (
		tenant: TenantContext,
		payload: TinybirdQueryRequest,
		options?: SqlQueryOptions,
	) => Effect.Effect<TinybirdQueryResponse, WarehouseSqlError>
	readonly sqlQuery: (
		tenant: TenantContext,
		sql: string,
		options?: SqlQueryOptions,
	) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, WarehouseSqlError>
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

const createClickHouseSqlClient = (config: ClickHouseSqlClientConfig): SqlClient => {
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

const createTinybirdSdkSqlClient = (config: TinybirdSdkSqlClientConfig): SqlClient => {
	const client = new Tinybird({
		baseUrl: config.host,
		token: config.token,
		datasources: {},
		pipes: {},
		devMode: false,
	})
	return {
		sql: async (sql: string) => client.sql(sql),
	}
}

const createClient = (config: SqlClientConfig): SqlClient =>
	config._tag === "clickhouse" ? createClickHouseSqlClient(config) : createTinybirdSdkSqlClient(config)

let sqlClientFactory: typeof createClient = createClient

const normalizeSqlForClickHouseClient = (sql: string): string =>
	sql
		.replace(/;\s*$/, "")
		.replace(/\s+FORMAT\s+(?:JSONEachRow|JSON)\s*$/i, "")
		.replace(/;\s*$/, "")

type ClickHouseErrorDetails = {
	readonly message: string
	readonly code?: string
	readonly type?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

const unknownToMessage = (error: unknown, fallback = "ClickHouse query failed"): string => {
	if (typeof error === "string") return error
	if (error instanceof Error) return error.message
	if (isRecord(error) && typeof error.message === "string") return error.message
	return fallback
}

const getClickHouseErrorDetails = (error: unknown): ClickHouseErrorDetails => {
	const message = unknownToMessage(error)
	if (!isRecord(error)) return { message }
	const code =
		typeof error.code === "string"
			? error.code
			: typeof error.code === "number"
				? String(error.code)
				: undefined
	const type = typeof error.type === "string" ? error.type : undefined
	return { message, code, type }
}

const authClickHouseTypes = new Set([
	"AUTHENTICATION_FAILED",
	"ACCESS_DENIED",
	"USER_DOESNT_EXIST",
	"REQUIRED_PASSWORD",
])

const configClickHouseTypes = new Set([
	"UNKNOWN_DATABASE",
	"UNKNOWN_TABLE",
	"TABLE_IS_DROPPED",
	"UNKNOWN_SETTING",
])

const transientClickHouseTypes = new Set([
	"NETWORK_ERROR",
	"SOCKET_TIMEOUT",
	"TOO_MANY_SIMULTANEOUS_QUERIES",
	"SERVER_OVERLOADED",
	"CANNOT_SCHEDULE_TASK",
	"KEEPER_EXCEPTION",
	"ALL_CONNECTION_TRIES_FAILED",
])

// CH error types raised when a column or function reference doesn't exist in
// the cluster's schema. For BYO-ClickHouse customers this is almost always
// schema drift between Maple's expected schema and what the cluster has —
// resolved by running schema apply, not by retrying. Surfacing it as a
// distinct category lets the MCP layer return an actionable message.
const schemaDriftClickHouseTypes = new Set([
	"UNKNOWN_IDENTIFIER",
	"NO_SUCH_COLUMN_IN_TABLE",
	"THERE_IS_NO_COLUMN",
	"NOT_FOUND_COLUMN_IN_BLOCK",
])

// Only retry transient upstream failures (5xx, 408, 429, network blips). Non-transient
// errors (auth, config, schema_drift, query) re-fail immediately — there's nothing to
// recover from by trying again. Caps at 2 retries (3 attempts total) to bound worst-case
// tail latency: at concurrency=4 in the alerting tick, a fully-degraded warehouse can
// still let the tick finish within its 60s window.
const TRANSIENT_RETRY_SCHEDULE = Schedule.exponential("100 millis", 2.0).pipe(
	Schedule.both(Schedule.recurs(2)),
)

const isTransientUpstreamError = (error: WarehouseSqlError): boolean =>
	error._tag === "@maple/http/errors/TinybirdQueryError" && error.category === "upstream"

export class WarehouseQueryService extends Context.Service<
	WarehouseQueryService,
	WarehouseQueryServiceShape
>()("WarehouseQueryService", {
		make: Effect.gen(function* () {
			const env = yield* Env
			const orgClickHouseSettings = yield* OrgClickHouseSettingsService

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
				const match = message.match(/(?:status|HTTP status|response status code)[:\s]+(\d{3})/i)
				if (match) return Number(match[1])
				const titleMatch = message.match(/\b(\d{3})\s+(?:error|service temporarily unavailable)\b/i)
				if (titleMatch) return Number(titleMatch[1])
				return undefined
			}

			const toTinybirdQueryError = (pipe: string, error: unknown) =>
				new TinybirdQueryError({
					message: cleanErrorMessage(unknownToMessage(error, "Tinybird query failed")),
					pipe,
				})

			const mapTinybirdError = (pipe: string, error: unknown) => {
				const details = getClickHouseErrorDetails(error)
				const rawMessage = details.message
				const message = cleanErrorMessage(rawMessage)
				const setting = detectQuotaSetting(rawMessage, details.code, details.type)
				const clickhouseFields = {
					clickhouseCode: details.code,
					clickhouseType: details.type,
				}
				if (setting) {
					return new TinybirdQuotaExceededError({ pipe, message, setting, ...clickhouseFields })
				}
				const upstreamStatus = extractUpstreamStatus(rawMessage)
				const type = details.type
				const isAuthFailure =
					upstreamStatus === 401 ||
					upstreamStatus === 403 ||
					(type !== undefined && authClickHouseTypes.has(type)) ||
					/authentication failed|access denied|not enough privileges|password is incorrect/i.test(
						rawMessage,
					)
				if (isAuthFailure) {
					return new TinybirdQueryError({
						pipe,
						message,
						category: "auth",
						upstreamStatus,
						...clickhouseFields,
					})
				}
				const isTransientFailure =
					(upstreamStatus !== undefined &&
						(upstreamStatus === 408 ||
							upstreamStatus === 429 ||
							(upstreamStatus >= 500 && upstreamStatus < 600))) ||
					(type !== undefined && transientClickHouseTypes.has(type)) ||
					/^Timeout error\.?$/i.test(rawMessage) ||
					/The user aborted a request|Failed to fetch|fetch failed|NetworkError|Load failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|certificate/i.test(
						rawMessage,
					)
				if (isTransientFailure) {
					return new TinybirdQueryError({
						pipe,
						message,
						category: "upstream",
						upstreamStatus,
						...clickhouseFields,
					})
				}
				const isConfigFailure =
					(upstreamStatus !== undefined && upstreamStatus === 404) ||
					(type !== undefined && configClickHouseTypes.has(type)) ||
					/Invalid URL|unknown database|unknown table|table .* does not exist|database .* does not exist/i.test(
						rawMessage,
					)
				if (isConfigFailure) {
					return new TinybirdQueryError({
						pipe,
						message,
						category: "config",
						upstreamStatus,
						...clickhouseFields,
					})
				}
				const isClientFailure =
					error instanceof SyntaxError ||
					/Cannot decode .* as JSON|Unexpected token .* JSON|Stream has been already consumed|Failed to parse ClickHouse response/i.test(
						rawMessage,
					)
				if (isClientFailure) {
					return new TinybirdQueryError({
						pipe,
						message,
						category: "client",
						upstreamStatus,
						...clickhouseFields,
					})
				}
				const isSchemaDrift =
					(type !== undefined && schemaDriftClickHouseTypes.has(type)) ||
					/Unknown (?:expression or function )?identifier|Missing columns|There is no column|No such column/i.test(
						rawMessage,
					)
				if (isSchemaDrift) {
					return new TinybirdQueryError({
						pipe,
						message,
						category: "schema_drift",
						upstreamStatus,
						...clickhouseFields,
					})
				}
				return new TinybirdQueryError({
					pipe,
					message,
					category: "query",
					upstreamStatus,
					...clickhouseFields,
				})
			}

			const sqlClientCacheKey = (config: SqlClientConfig): string =>
				config._tag === "clickhouse"
					? `clickhouse:${config.url}:${config.username}:${config.password}:${config.database}`
					: `tinybird:${config.host}:${config.token}`

			const getCachedOrCreateClient = (orgId: OrgId | "__managed__", config: SqlClientConfig) => {
				const now = Date.now()
				const cacheKey = sqlClientCacheKey(config)
				const cached = clientCache.get(orgId)
				if (cached && cached.cacheKey === cacheKey && cached.expiresAt > now) {
					return cached.client
				}
				const client = sqlClientFactory(config)
				clientCache.set(orgId, { client, cacheKey, expiresAt: now + CLIENT_CACHE_TTL_MS })
				return client
			}

			/**
			 * Resolve the upstream config for this tenant's queries.
			 *
			 * Resolution order:
			 *   1. Per-org BYO ClickHouse row (`org_clickhouse_settings`)
			 *   2. Env-level managed ClickHouse (`CLICKHOUSE_URL` set)
			 *   3. Env-level managed Tinybird (`TINYBIRD_HOST` + `TINYBIRD_TOKEN`)
			 */
			const resolveSqlConfig = Effect.fn("WarehouseQueryService.resolveSqlConfig")(function* (
				tenant: TenantContext,
				label: string,
			) {
				const override = yield* orgClickHouseSettings
					.resolveRuntimeConfig(tenant.orgId)
					.pipe(Effect.mapError((error) => toTinybirdQueryError(label, error)))

				if (Option.isSome(override)) {
					yield* Effect.annotateCurrentSpan("clientSource", "org_override")
					yield* Effect.annotateCurrentSpan("db.client", "clickhouse")
					return {
						config: {
							_tag: "clickhouse" as const,
							url: override.value.url,
							username: override.value.user,
							password: override.value.password,
							database: override.value.database,
						},
						source: "org_override" as const,
					}
				}

				yield* Effect.annotateCurrentSpan("clientSource", "managed")
				if (Option.isSome(env.CLICKHOUSE_URL)) {
					yield* Effect.annotateCurrentSpan("db.client", "clickhouse")
					return {
						config: {
							_tag: "clickhouse" as const,
							url: env.CLICKHOUSE_URL.value,
							username: env.CLICKHOUSE_USER,
							password: Option.match(env.CLICKHOUSE_PASSWORD, {
								onNone: () => Redacted.value(env.TINYBIRD_TOKEN),
								onSome: Redacted.value,
							}),
							database: env.CLICKHOUSE_DATABASE,
						},
						source: "managed" as const,
					}
				}

				yield* Effect.annotateCurrentSpan("db.client", "tinybird-sdk")
				return {
					config: {
						_tag: "tinybird" as const,
						host: env.TINYBIRD_HOST,
						token: Redacted.value(env.TINYBIRD_TOKEN),
					},
					source: "managed" as const,
				}
			})

			/**
			 * Cap traced SQL at 16 KB. OTel's default attribute size limit is 32 KB,
			 * and 16 KB covers the overwhelming majority of compiled DSL queries while
			 * leaving headroom for other span attributes. Logs use a tighter cap below.
			 */
			const SQL_TRACE_MAX = 16_384
			const SQL_LOG_MAX = 1_000

			const truncateSql = (s: string, maxLen: number) =>
				s.length > maxLen ? s.slice(0, maxLen) + "...[truncated]" : s

			/**
			 * Stable 32-bit FNV-1a hash over SQL with literals and numbers normalized.
			 * Lets the same query with different params group together in trace search.
			 */
			const fingerprintSql = (s: string): string => {
				const normalized = s.replace(/'[^']*'/g, "'?'").replace(/\b\d+\b/g, "?")
				let h = 0x811c9dc5
				for (let i = 0; i < normalized.length; i++) {
					h ^= normalized.charCodeAt(i)
					h = Math.imul(h, 0x01000193)
				}
				return (h >>> 0).toString(16).padStart(8, "0")
			}

			const executeSql = Effect.fn("WarehouseQueryService.executeSql")(function* (
				tenant: TenantContext,
				sql: string,
				pipe: string,
				options?: SqlQueryOptions,
			) {
				const startedAtMs = yield* Clock.currentTimeMillis
				yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
				yield* Effect.annotateCurrentSpan("tenant.userId", tenant.userId)
				yield* Effect.annotateCurrentSpan("tenant.authMode", tenant.authMode)

				const leftoverParam = sql.match(/__PARAM_(\w+)__/)
				if (leftoverParam) {
					return yield* new TinybirdQueryError({
						pipe,
						message: `Compiled SQL contains unresolved param '${leftoverParam[1]}' — query was built with param.${leftoverParam[1]}() but '${leftoverParam[1]}' was not provided in the runtime params object`,
					})
				}

				const resolved = yield* resolveSqlConfig(tenant, pipe)
				const peerService = resolved.config._tag === "clickhouse" ? "clickhouse" : "tinybird"
				yield* Effect.annotateCurrentSpan("db.system", peerService)
				yield* Effect.annotateCurrentSpan("peer.service", peerService)
				const settings = resolveSettings(options)
				const sqlForClient =
					resolved.config._tag === "clickhouse" ? normalizeSqlForClickHouseClient(sql) : sql
				const finalSql = appendSettings(sqlForClient, settings)
				const sqlLength = finalSql.length
				const sqlTruncated = sqlLength > SQL_TRACE_MAX
				yield* Effect.annotateCurrentSpan("db.statement", truncateSql(finalSql, SQL_TRACE_MAX))
				yield* Effect.annotateCurrentSpan("db.statement.length", sqlLength)
				yield* Effect.annotateCurrentSpan("db.statement.truncated", sqlTruncated)
				yield* Effect.annotateCurrentSpan("db.statement.fingerprint", fingerprintSql(finalSql))
				yield* Effect.annotateCurrentSpan("query.pipe", pipe)
				if (options?.context) yield* Effect.annotateCurrentSpan("query.context", options.context)
				if (options?.profile) yield* Effect.annotateCurrentSpan("query.profile", options.profile)
				if (settings) yield* Effect.annotateCurrentSpan("ch.settings", JSON.stringify(settings))

				const cacheKey = resolved.source === "managed" ? "__managed__" : tenant.orgId
				const client = getCachedOrCreateClient(cacheKey, resolved.config)
				let retryAttempts = 0
				const result = yield* Effect.tryPromise({
					try: () => client.sql(finalSql),
					catch: (error) => mapTinybirdError(pipe, error),
				}).pipe(
					Effect.tapError((error) =>
						isTransientUpstreamError(error)
							? Effect.sync(() => {
									retryAttempts++
								})
							: Effect.void,
					),
					Effect.retry({
						schedule: TRANSIENT_RETRY_SCHEDULE,
						while: isTransientUpstreamError,
					}),
					Effect.tapError((error) =>
						Effect.gen(function* () {
							const elapsedMs = (yield* Clock.currentTimeMillis) - startedAtMs
							yield* Effect.annotateCurrentSpan("db.duration_ms", elapsedMs)
							yield* Effect.annotateCurrentSpan("db.retry.attempts", retryAttempts)
							yield* Effect.logError("WarehouseQueryService.executeSql failed", {
								pipe,
								context: options?.context,
								orgId: tenant.orgId,
								backend: resolved.config._tag,
								durationMs: elapsedMs,
								retryAttempts,
								error: String(error),
								message: error.message,
								sql: truncateSql(finalSql, SQL_LOG_MAX),
								sqlLength,
								sqlFingerprint: fingerprintSql(finalSql),
								profile: options?.profile,
							})
						}),
					),
				)

				yield* Effect.annotateCurrentSpan("result.rowCount", result.data.length)
				yield* Effect.annotateCurrentSpan(
					"db.duration_ms",
					(yield* Clock.currentTimeMillis) - startedAtMs,
				)
				yield* Effect.annotateCurrentSpan("db.retry.attempts", retryAttempts)
				return result.data
			})

			const query = Effect.fn("WarehouseQueryService.query")(function* (
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

			const sqlQuery = Effect.fn("WarehouseQueryService.sqlQuery")(function* (
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

			const ingest = Effect.fn("WarehouseQueryService.ingest")(function* <T>(
				tenant: TenantContext,
				datasource: string,
				rows: ReadonlyArray<T>,
			) {
				yield* Effect.annotateCurrentSpan("datasource", datasource)
				yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
				yield* Effect.annotateCurrentSpan("rowCount", rows.length)

				if (rows.length === 0) return

				const label = `ingest:${datasource}`
				const resolved = yield* resolveSqlConfig(tenant, label)
				const ndjson = rows.map((row) => JSON.stringify(row)).join("\n")

				const { url, headers } =
					resolved.config._tag === "tinybird"
						? {
								url: `${resolved.config.host.replace(/\/$/, "")}/v0/events?name=${encodeURIComponent(datasource)}&wait=false`,
								headers: {
									"Content-Type": "application/x-ndjson",
									Authorization: `Bearer ${resolved.config.token}`,
								} as Record<string, string>,
							}
						: (() => {
								// Direct INSERT to ClickHouse using JSONEachRow — same wire format
								// as the NDJSON we already build above. The query string carries the
								// target table; ClickHouse parses each line as one row.
								const ch: Record<string, string> = {
									"Content-Type": "application/x-ndjson",
									"X-ClickHouse-User": resolved.config.username,
									"X-ClickHouse-Database": resolved.config.database,
								}
								if (resolved.config.password.length > 0) {
									ch["X-ClickHouse-Key"] = resolved.config.password
								}
								return {
									url: `${resolved.config.url.replace(/\/$/, "")}/?query=${encodeURIComponent(`INSERT INTO ${datasource} FORMAT JSONEachRow`)}`,
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
						Effect.logError("WarehouseQueryService.ingest failed", {
							datasource,
							rowCount: rows.length,
							backend: resolved.config._tag,
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
			} satisfies WarehouseQueryServiceShape
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
		sqlClientFactory = factory
		clientCache.clear()
	},
	reset: () => {
		sqlClientFactory = createClient
		clientCache.clear()
	},
}
