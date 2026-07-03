import { Clock, Duration, Effect, Ref, Schedule } from "effect"
import {
	type WarehouseQueryRequest,
	WarehouseQueryResponse,
	WarehouseSchemaDriftError,
	WarehouseUpstreamError,
	WarehouseValidationError,
} from "@maple/domain/http"
import type { WarehouseQueryName } from "@maple/domain/warehouse-queries"
import { compilePipeQuery, type CompiledQuery } from "../ch"
import type { ExecutorQueryOptions, WarehouseExecutorShape } from "../observability"
import {
	appendSettings,
	type QueryProfileName,
	resolveSettings,
	stripTinybirdRestrictedSettings,
} from "../profiles"
import { mapWarehouseError, toWarehouseQueryError, type WarehouseSqlError } from "./errors"
import {
	SQL_LOG_MAX,
	SQL_TRACE_MAX,
	fingerprintSql,
	normalizeSqlForClickHouseClient,
	truncateSql,
} from "./fingerprint"
import type {
	ExecutionTenant,
	ResolvedWarehouseConfig,
	SqlQueryOptions,
	WarehouseExecutorDeps,
	WarehouseQueryServiceShape,
	WarehouseSqlClient,
} from "./ports"

const CLIENT_CACHE_TTL_MS = 30_000

interface CachedClient {
	client: WarehouseSqlClient
	cacheKey: string
	expiresAt: number
}

const sqlClientCacheKey = (config: ResolvedWarehouseConfig): string =>
	config._tag === "clickhouse"
		? `clickhouse:${config.url}:${config.username}:${config.password}:${config.database}`
		: `tinybird:${config.host}:${config.token}`

// Only retry transient upstream failures (5xx, 408, 429, network blips). Non-transient
// errors (auth, config, schema_drift, query) re-fail immediately — there's nothing to
// recover from by trying again. Caps at 2 retries (3 attempts total) to bound worst-case
// tail latency: at concurrency=4 in the alerting tick, a fully-degraded warehouse can
// still let the tick finish within its 60s window.
const TRANSIENT_RETRY_SCHEDULE = Schedule.exponential("100 millis", 2.0).pipe(
	Schedule.both(Schedule.recurs(2)),
)

const isTransientUpstreamError = (error: WarehouseSqlError): boolean =>
	error instanceof WarehouseUpstreamError

// Client-side ceiling for a single query attempt. Tinybird's server-side
// `max_execution_time` is not always honored — when its query queue is saturated
// the request sits waiting, then rides the ambient ~30s Cloudflare Worker fetch
// timeout (observed: a `list`-profile query with `max_execution_time=15` still
// aborting at 30s). We enforce our own bound derived from the query's cost
// profile: the server budget plus headroom for queue + network. Queries with no
// declared budget fall back to a hard 30s cap (no worse than the ambient limit).
// The `unbounded` profile is the explicit opt-out from cost limits, so it gets no
// client cap either (documented for known-cheap queries; on Workers it still
// rides the ambient ~30s limit). The timeout maps to a non-transient
// WarehouseQueryError, so it fails fast instead of feeding the retry loop.
const CLIENT_TIMEOUT_BUFFER_MS = 5_000
const MANAGED_QUERY_HARD_TIMEOUT_MS = 30_000

const clientTimeoutMs = (
	profile: QueryProfileName | undefined,
	maxExecutionTimeS: number | undefined,
): number | undefined => {
	if (profile === "unbounded") return undefined
	return maxExecutionTimeS !== undefined
		? maxExecutionTimeS * 1000 + CLIENT_TIMEOUT_BUFFER_MS
		: MANAGED_QUERY_HARD_TIMEOUT_MS
}

/**
 * Build the managed-warehouse executor. Owns SQL execution, retry, error
 * mapping, the per-instance client cache, OrgId scoping enforcement, and span
 * instrumentation. The host app injects driver construction (`createClient`)
 * and per-org config resolution (`resolveConfig`) via `deps`.
 *
 * The client cache is per-instance (one per layer build): a single instance in
 * production (the layer is built once) and a fresh one per test build, so tests
 * never see a stale client from a prior fake factory.
 */
export const makeWarehouseExecutor = (deps: WarehouseExecutorDeps): WarehouseQueryServiceShape => {
	const clientCache = new Map<string, CachedClient>()

	const getCachedOrCreateClient = (
		cacheKey: string,
		config: ResolvedWarehouseConfig,
		nowMs: number,
	): WarehouseSqlClient => {
		const configKey = sqlClientCacheKey(config)
		const cached = clientCache.get(cacheKey)
		if (cached && cached.cacheKey === configKey && cached.expiresAt > nowMs) {
			return cached.client
		}
		const client = deps.createClient(config)
		clientCache.set(cacheKey, { client, cacheKey: configKey, expiresAt: nowMs + CLIENT_CACHE_TTL_MS })
		return client
	}

	// Client-kind is load-bearing: the service-map DB-edge MV
	// (service_map_db_edges_hourly_mv) only counts SpanKind IN ('Client','Producer').
	const executeSql = Effect.fn("WarehouseQueryService.executeSql", { kind: "client" })(function* (
		tenant: ExecutionTenant,
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
			// An unresolved param is a compile-time bug in Maple's query construction,
			// not a recoverable runtime failure — surface it as a defect.
			return yield* Effect.die(
				new Error(
					`Compiled SQL contains unresolved param '${leftoverParam[1]}' — query was built with param.${leftoverParam[1]}() but '${leftoverParam[1]}' was not provided in the runtime params object`,
				),
			)
		}

		// Control-plane datasources (e.g. alert_checks) are written via `ingest`,
		// which is hard-pinned to the managed Tinybird pipeline. They do NOT exist
		// in a per-org BYO ClickHouse, so their reads must pin to the same ingest
		// config to stay symmetric with the write — otherwise a BYO-CH org reads an
		// empty table from its own ClickHouse.
		const resolveFn =
			options?.pinToIngestConfig && deps.resolveIngestConfig
				? deps.resolveIngestConfig
				: deps.resolveConfig
		const resolved = yield* resolveFn(tenant, pipe)
		if (options?.pinToIngestConfig) yield* Effect.annotateCurrentSpan("query.routing", "ingest")
		const peerService = resolved.config._tag === "clickhouse" ? "clickhouse" : "tinybird"
		yield* Effect.annotateCurrentSpan("db.system.name", peerService)
		yield* Effect.annotateCurrentSpan("peer.service", peerService)
		// Tinybird's managed warehouse restricts some settings (e.g. max_block_size:
		// "Usage of setting 'max_block_size' is restricted"). It is reached either via
		// the Tinybird SDK (_tag "tinybird") or its ClickHouse-compatible gateway
		// (_tag "clickhouse", when CLICKHOUSE_URL is set); both enforce that policy.
		// Only a genuine per-org BYO ClickHouse (source "org_override") supports those
		// settings, so strip everywhere except there. Gating on `source` (not `_tag`)
		// is what fixes the managed CH-gateway path.
		const settings =
			resolved.source === "org_override"
				? resolveSettings(options)
				: stripTinybirdRestrictedSettings(resolveSettings(options))
		const sqlForClient =
			resolved.config._tag === "clickhouse" ? normalizeSqlForClickHouseClient(sql) : sql
		const finalSql = appendSettings(sqlForClient, settings)
		const sqlLength = finalSql.length
		const sqlTruncated = sqlLength > SQL_TRACE_MAX
		yield* Effect.annotateCurrentSpan("db.query.text", truncateSql(finalSql, SQL_TRACE_MAX))
		yield* Effect.annotateCurrentSpan("db.query.length", sqlLength)
		yield* Effect.annotateCurrentSpan("db.query.truncated", sqlTruncated)
		yield* Effect.annotateCurrentSpan("db.query.fingerprint", fingerprintSql(finalSql))
		yield* Effect.annotateCurrentSpan("query.pipe", pipe)
		if (options?.context) yield* Effect.annotateCurrentSpan("query.context", options.context)
		if (options?.profile) yield* Effect.annotateCurrentSpan("query.profile", options.profile)
		if (settings) yield* Effect.annotateCurrentSpan("ch.settings", JSON.stringify(settings))

		const cacheKey = resolved.source === "managed" ? "__managed__" : tenant.orgId
		const client = getCachedOrCreateClient(cacheKey, resolved.config, yield* Clock.currentTimeMillis)
		const attemptTimeoutMs = clientTimeoutMs(options?.profile, settings?.maxExecutionTime)
		const retryAttempts = yield* Ref.make(0)
		const queryAttempt = Effect.tryPromise({
			try: () => client.sql(finalSql),
			catch: (error) => mapWarehouseError(pipe, error),
		})
		// `db.duration_ms` measures warehouse execution only — captured here, after
		// config resolution + settings/client-cache preamble, immediately before the
		// query runs. `startedAtMs` (captured at span entry) feeds the separate
		// `db.total_duration_ms`, covering the whole executeSql span including preamble.
		const sqlStartedMs = yield* Clock.currentTimeMillis
		const result = yield* (
			// Bound each attempt: don't let a queued query ride the ambient ~30s
			// Worker fetch limit past its declared budget. Non-transient, so it
			// fails fast rather than retrying into a struggling warehouse. Skipped
			// entirely for the `unbounded` profile (explicit opt-out).
			attemptTimeoutMs === undefined
				? queryAttempt
				: queryAttempt.pipe(
						Effect.timeoutOrElse({
							duration: Duration.millis(attemptTimeoutMs),
							orElse: () =>
								// Constructed directly via `toWarehouseQueryError` (non-transient) — this
								// timeout must never flow through `mapWarehouseError`, whose transient
								// regex could reclassify a "timeout" message and feed it back into the
								// retry loop, re-amplifying load on an already-struggling warehouse.
								Effect.fail(
									toWarehouseQueryError(
										pipe,
										new Error(`Warehouse query exceeded ${attemptTimeoutMs}ms client timeout`),
									),
								),
						}),
					)
		).pipe(
			Effect.tapError((error) =>
				isTransientUpstreamError(error) ? Ref.update(retryAttempts, (n) => n + 1) : Effect.void,
			),
			Effect.retry({
				schedule: TRANSIENT_RETRY_SCHEDULE,
				while: isTransientUpstreamError,
			}),
			Effect.tapError((error) =>
				Effect.gen(function* () {
					const nowMs = yield* Clock.currentTimeMillis
					const elapsedMs = nowMs - sqlStartedMs
					const totalElapsedMs = nowMs - startedAtMs
					const attempts = yield* Ref.get(retryAttempts)
					yield* Effect.annotateCurrentSpan("db.duration_ms", elapsedMs)
					yield* Effect.annotateCurrentSpan("db.total_duration_ms", totalElapsedMs)
					yield* Effect.annotateCurrentSpan("db.retry.attempts", attempts)
					yield* Effect.logError("WarehouseQueryService.executeSql failed", {
						pipe,
						context: options?.context,
						orgId: tenant.orgId,
						backend: resolved.config._tag,
						durationMs: elapsedMs,
						retryAttempts: attempts,
						errorTag: error._tag,
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
		const completedAtMs = yield* Clock.currentTimeMillis
		yield* Effect.annotateCurrentSpan("db.duration_ms", completedAtMs - sqlStartedMs)
		yield* Effect.annotateCurrentSpan("db.total_duration_ms", completedAtMs - startedAtMs)
		yield* Effect.annotateCurrentSpan("db.retry.attempts", yield* Ref.get(retryAttempts))
		return result.data
	})

	const query = Effect.fn("WarehouseQueryService.query")(function* (
		tenant: ExecutionTenant,
		payload: WarehouseQueryRequest,
		options?: SqlQueryOptions,
	) {
		yield* Effect.annotateCurrentSpan("pipe", payload.pipeName)
		yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)

		if (!tenant.orgId || tenant.orgId.trim() === "") {
			return yield* new WarehouseValidationError({
				pipeName: payload.pipeName,
				message: "org_id must not be empty",
			})
		}

		const compiled = compilePipeQuery(payload.pipeName, {
			...payload.params,
			org_id: tenant.orgId,
		})

		if (!compiled) {
			return yield* new WarehouseValidationError({
				message: `Unsupported pipe: ${payload.pipeName}`,
				pipeName: payload.pipeName,
			})
		}

		const rows = yield* executeSql(tenant, compiled.sql, payload.pipeName, options)
		const decodedRows = yield* compiled.decodeRows(rows).pipe(
			Effect.mapError(
				(error) =>
					new WarehouseSchemaDriftError({
						pipeName: payload.pipeName,
						message: error.message,
						cause: error,
					}),
			),
		)

		return new WarehouseQueryResponse({
			data: Array.from(decodedRows),
		})
	})

	const sqlQuery = Effect.fn("WarehouseQueryService.sqlQuery")(function* (
		tenant: ExecutionTenant,
		sql: string,
		options?: SqlQueryOptions,
	) {
		if (!tenant.orgId || tenant.orgId.trim() === "") {
			return yield* new WarehouseValidationError({
				pipeName: "sqlQuery",
				message: "org_id must not be empty (sqlQuery)",
			})
		}
		if (!sql.includes("OrgId")) {
			return yield* new WarehouseValidationError({
				pipeName: "sqlQuery",
				message: "SQL query must contain OrgId filter (sqlQuery)",
			})
		}
		return yield* executeSql(tenant, sql, "sqlQuery", options)
	})

	const compiledQuery = Effect.fn("WarehouseQueryService.compiledQuery")(function* <T>(
		tenant: ExecutionTenant,
		compiled: CompiledQuery<T>,
		options?: SqlQueryOptions,
	) {
		const rows = yield* sqlQuery(tenant, compiled.sql, options)
		return yield* compiled.decodeRows(rows).pipe(
			Effect.mapError(
				(error) =>
					new WarehouseSchemaDriftError({
						pipeName: "compiledQuery",
						message: error.message,
						cause: error,
					}),
			),
		)
	})

	const compiledQueryFirst = Effect.fn("WarehouseQueryService.compiledQueryFirst")(function* <T>(
		tenant: ExecutionTenant,
		compiled: CompiledQuery<T>,
		options?: SqlQueryOptions,
	) {
		const rows = yield* sqlQuery(tenant, compiled.sql, options)
		return yield* compiled.decodeFirstRow(rows).pipe(
			Effect.mapError(
				(error) =>
					new WarehouseSchemaDriftError({
						pipeName: "compiledQueryFirst",
						message: error.message,
						cause: error,
					}),
			),
		)
	})

	const ingest = Effect.fn("WarehouseQueryService.ingest")(function* <T>(
		tenant: ExecutionTenant,
		datasource: string,
		rows: ReadonlyArray<T>,
	) {
		yield* Effect.annotateCurrentSpan("datasource", datasource)
		yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
		yield* Effect.annotateCurrentSpan("rowCount", rows.length)

		if (rows.length === 0) return

		const label = `ingest:${datasource}`
		// Writes resolve through the ingest-specific resolver when provided: the
		// host points it at the managed Tinybird pipeline, never a per-org BYO
		// ClickHouse READ override (routing writes through the override 500'd every
		// insert and broke demo-seed onboarding). Falls back to the read resolver.
		const resolveForIngest = deps.resolveIngestConfig ?? deps.resolveConfig
		const resolved = yield* resolveForIngest(tenant, label)

		// Insert through the same client the read path uses (official
		// @clickhouse/client-web for ClickHouse, Tinybird Events API for
		// Tinybird) so the wire protocol is handled correctly — a hand-rolled
		// `?query=INSERT … FORMAT JSONEachRow` POST had its query param dropped
		// by managed ClickHouse, which then parsed the NDJSON body as SQL.
		const cacheKey = resolved.source === "managed" ? "__managed__" : tenant.orgId
		const client = getCachedOrCreateClient(cacheKey, resolved.config, yield* Clock.currentTimeMillis)

		yield* Effect.tryPromise({
			try: () => client.insert(datasource, rows),
			catch: (error) => toWarehouseQueryError(label, error),
		}).pipe(
			Effect.tapError((error) =>
				Effect.logError("WarehouseQueryService.ingest failed", {
					datasource,
					rowCount: rows.length,
					backend: resolved.config._tag,
					errorTag: error._tag,
					message: error.message,
				}),
			),
		)
	})

	const asExecutor = (tenant: ExecutionTenant): WarehouseExecutorShape => ({
		orgId: tenant.orgId,
		query: <T>(
			pipe: WarehouseQueryName,
			params: Record<string, unknown>,
			options?: ExecutorQueryOptions,
		) =>
			query(tenant, { pipeName: pipe, params }, { ...options, context: `pipe:${pipe}` }).pipe(
				Effect.map((response) => ({ data: response.data as unknown as ReadonlyArray<T> })),
				Effect.withSpan("WarehouseExecutor.query", {
					attributes: {
						pipe,
						orgId: tenant.orgId,
						"query.profile": options?.profile,
						"query.context": `pipe:${pipe}`,
					},
				}),
			),
		sqlQuery: <T>(sql: string, options?: ExecutorQueryOptions) =>
			sqlQuery(tenant, sql, { ...options, context: "warehouseExecutor.sqlQuery" }).pipe(
				Effect.map((rows) => rows as unknown as ReadonlyArray<T>),
				Effect.withSpan("WarehouseExecutor.sqlQuery", {
					attributes: {
						orgId: tenant.orgId,
						"query.profile": options?.profile,
						"query.context": "warehouseExecutor.sqlQuery",
					},
				}),
			),
		compiledQuery: <T>(compiled: CompiledQuery<T>, options?: ExecutorQueryOptions) =>
			compiledQuery(tenant, compiled, { ...options, context: "warehouseExecutor.compiledQuery" }).pipe(
				Effect.withSpan("WarehouseExecutor.compiledQuery", {
					attributes: {
						orgId: tenant.orgId,
						"query.profile": options?.profile,
						"query.context": "warehouseExecutor.compiledQuery",
					},
				}),
			),
		compiledQueryFirst: <T>(compiled: CompiledQuery<T>, options?: ExecutorQueryOptions) =>
			compiledQueryFirst(tenant, compiled, {
				...options,
				context: "warehouseExecutor.compiledQueryFirst",
			}).pipe(
				Effect.withSpan("WarehouseExecutor.compiledQueryFirst", {
					attributes: {
						orgId: tenant.orgId,
						"query.profile": options?.profile,
						"query.context": "warehouseExecutor.compiledQueryFirst",
					},
				}),
			),
	})

	return {
		query,
		sqlQuery,
		compiledQuery,
		compiledQueryFirst,
		ingest,
		asExecutor,
	} satisfies WarehouseQueryServiceShape
}
