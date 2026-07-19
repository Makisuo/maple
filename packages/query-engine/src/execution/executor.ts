import { Clock, Duration, Effect, Ref, Schedule } from "effect"
import {
	MAX_RAW_SQL_RESULT_BYTES,
	MAX_RAW_SQL_RESULT_ROWS,
	RawSqlValidationError,
	type WarehouseQueryRequest,
	WarehouseQueryResponse,
	WarehouseSchemaDriftError,
	WarehouseUpstreamError,
	WarehouseValidationError,
} from "@maple/domain/http"
import type { WarehouseQueryName } from "@maple/domain/warehouse-queries"
import { compilePipeQuery, type CompiledQuery } from "../ch"
import type { WarehouseExecutorShape } from "../observability"
import {
	appendSettings,
	type QueryProfileName,
	resolveSettings,
	stripTinybirdRestrictedSettings,
} from "../profiles"
import { mapWarehouseError, toWarehouseQueryError } from "./errors"
import { WarehouseResponseLimitError } from "./response-limits"
import {
	SQL_LOG_MAX,
	SQL_TRACE_MAX,
	fingerprintSql,
	normalizeSqlForClickHouseClient,
	truncateSql,
} from "./fingerprint"
import { BackendDialect } from "./backend"
import { findIngestPinnedTable } from "./datasource-routing"
import type {
	ExecutionTenant,
	ResolvedWarehouseConfig,
	RoutePurpose,
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
	config.kind === "tinybird"
		? `tinybird:${config.host}:${config.token}`
		: `${config.kind}:${config.url}:${config.username}:${config.password}:${config.database}`

// Only retry transient upstream failures (5xx, 408, 429, network blips). Non-transient
// errors (auth, config, schema_drift, query) re-fail immediately — there's nothing to
// recover from by trying again. Caps at 2 retries (3 attempts total) to bound worst-case
// tail latency: at concurrency=4 in the alerting tick, a fully-degraded warehouse can
// still let the tick finish within its 60s window.
const TRANSIENT_RETRY_SCHEDULE = Schedule.exponential("100 millis", 2.0).pipe(
	Schedule.both(Schedule.recurs(2)),
)

const isTransientUpstreamError = (error: unknown): error is WarehouseUpstreamError =>
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
		execution: "trusted" | "raw" = "trusted",
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
		// in a per-org BYO ClickHouse, so their reads must route to the same ingest
		// config to stay symmetric with the write — otherwise a BYO-CH org reads an
		// empty table from its own ClickHouse. That routing is declared at the
		// query definition (`.routing("ingest")` → `options.route`).
		const purpose: RoutePurpose =
			execution === "raw" ? "raw" : options?.route === "ingest" ? "ingest" : "read"
		const resolved = yield* deps.resolveRoute(tenant, purpose, pipe)
		// Safety net for the silent-empty-table failure: an ingest-pinned table
		// read against an org's own BYO ClickHouse returns no rows, not an error.
		if (purpose !== "ingest" && resolved.source === "org-byo") {
			const pinnedTable = findIngestPinnedTable(sql)
			if (pinnedTable !== undefined) {
				yield* Effect.logWarning(
					'Query reads an ingest-pinned datasource from a BYO ClickHouse — declare .routing("ingest") at the query definition',
					{ pipe, table: pinnedTable, orgId: tenant.orgId },
				)
			}
		}
		// Legacy spelling of `warehouse.route: "ingest"` — dual-emitted until
		// dashboards move to the `warehouse.*` attributes.
		if (purpose === "ingest") yield* Effect.annotateCurrentSpan("query.routing", "ingest")
		const dialect = BackendDialect[resolved.config.kind]
		const clientSource = resolved.source === "org-byo" ? "org_override" : "managed"
		yield* Effect.annotateCurrentSpan("warehouse.backend", resolved.config.kind)
		yield* Effect.annotateCurrentSpan("warehouse.route", purpose)
		yield* Effect.annotateCurrentSpan("warehouse.config_source", resolved.source)
		yield* Effect.annotateCurrentSpan("clientSource", clientSource)
		yield* Effect.annotateCurrentSpan("db.client", dialect.dbClient)
		yield* Effect.annotateCurrentSpan("db.system.name", dialect.dbSystemName)
		yield* Effect.annotateCurrentSpan("peer.service", dialect.peerService)
		const settings = dialect.stripTinybirdRestrictedSettings
			? stripTinybirdRestrictedSettings(resolveSettings(options))
			: resolveSettings(options)
		const sqlForClient = dialect.normalizeSqlForClient ? normalizeSqlForClickHouseClient(sql) : sql
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

		const client = getCachedOrCreateClient(
			resolved.clientCacheKey,
			resolved.config,
			yield* Clock.currentTimeMillis,
		)
		const attemptTimeoutMs = clientTimeoutMs(options?.profile, settings?.maxExecutionTime)
		const retryAttempts = yield* Ref.make(0)
		const responseLimits =
			execution === "raw"
				? { maxRows: MAX_RAW_SQL_RESULT_ROWS, maxBytes: MAX_RAW_SQL_RESULT_BYTES }
				: undefined
		const queryAttempt = Effect.tryPromise({
			try: () => client.sql(finalSql, responseLimits === undefined ? undefined : { responseLimits }),
			catch: (error) =>
				error instanceof WarehouseResponseLimitError
					? new RawSqlValidationError({
							code: "ResourceLimit",
							message: error.message,
						})
					: mapWarehouseError(pipe, error),
		})
		// `db.duration_ms` measures warehouse execution only — captured here, after
		// config resolution + settings/client-cache preamble, immediately before the
		// query runs. `startedAtMs` (captured at span entry) feeds the separate
		// `db.total_duration_ms`, covering the whole executeSql span including preamble.
		const sqlStartedMs = yield* Clock.currentTimeMillis
		// Bound each attempt: don't let a queued query ride the ambient ~30s Worker
		// fetch limit past its declared budget. The timeout is non-transient, so it
		// fails fast instead of retrying. The `unbounded` profile explicitly opts out.
		const boundedAttempt =
			attemptTimeoutMs === undefined
				? queryAttempt
				: queryAttempt.pipe(
						Effect.timeoutOrElse({
							duration: Duration.millis(attemptTimeoutMs),
							orElse: () =>
								// Constructed directly via `toWarehouseQueryError` so a transient
								// message matcher cannot feed this client timeout into the retry loop.
								Effect.fail(
									toWarehouseQueryError(
										pipe,
										new Error(
											`Warehouse query exceeded ${attemptTimeoutMs}ms client timeout`,
										),
									),
								),
						}),
					)
		const result = yield* boundedAttempt.pipe(
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
					const failedTransientAttempts = yield* Ref.get(retryAttempts)
					const attempts = isTransientUpstreamError(error)
						? Math.max(0, failedTransientAttempts - 1)
						: failedTransientAttempts
					yield* Effect.annotateCurrentSpan("db.duration_ms", elapsedMs)
					yield* Effect.annotateCurrentSpan("db.total_duration_ms", totalElapsedMs)
					yield* Effect.annotateCurrentSpan("db.retry.attempts", attempts)
					yield* Effect.logError("WarehouseQueryService.executeSql failed", {
						pipe,
						context: options?.context,
						orgId: tenant.orgId,
						backend: resolved.config.kind,
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

	const executeTrustedSql = (
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options?: SqlQueryOptions,
	) =>
		executeSql(tenant, sql, pipe, options, "trusted").pipe(
			// A trusted driver call never receives response limits, so this branch is
			// an impossible implementation defect rather than part of its error API.
			Effect.catchTag("@maple/http/errors/RawSqlValidationError", Effect.die),
		)

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

		const rows = yield* executeTrustedSql(tenant, compiled.sql, payload.pipeName, options)
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
		return yield* executeTrustedSql(tenant, sql, "sqlQuery", options)
	})

	const rawSqlQuery = Effect.fn("WarehouseQueryService.rawSqlQuery")(function* (
		tenant: ExecutionTenant,
		sql: string,
		options?: Pick<SqlQueryOptions, "profile" | "context">,
	) {
		if (!sql.includes("OrgId")) {
			return yield* new RawSqlValidationError({
				code: "MissingOrgFilter",
				message: "Raw SQL must contain the expanded OrgId filter",
			})
		}
		return yield* executeSql(tenant, sql, "rawSqlQuery", options, "raw")
	})

	// A compiled query can carry `.routing("ingest")` from its definition — that
	// wins over the (absent) per-call option so the table→routing knowledge
	// lives next to the query, not at every call site.
	const withCompiledRouting = <T>(
		compiled: CompiledQuery<T>,
		options?: SqlQueryOptions,
	): SqlQueryOptions | undefined =>
		compiled.routing === "ingest" ? { ...options, route: "ingest" } : options

	const compiledQuery = Effect.fn("WarehouseQueryService.compiledQuery")(function* <T>(
		tenant: ExecutionTenant,
		compiled: CompiledQuery<T>,
		options?: SqlQueryOptions,
	) {
		const rows = yield* sqlQuery(tenant, compiled.sql, withCompiledRouting(compiled, options))
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
		const rows = yield* sqlQuery(tenant, compiled.sql, withCompiledRouting(compiled, options))
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
		// Writes resolve with purpose "ingest": the host routes them to the managed
		// Tinybird pipeline, never a per-org BYO ClickHouse READ override (routing
		// writes through the override 500'd every insert and broke demo-seed
		// onboarding).
		const resolved = yield* deps.resolveRoute(tenant, "ingest", label)
		const dialect = BackendDialect[resolved.config.kind]
		const clientSource = resolved.source === "org-byo" ? "org_override" : "managed"
		yield* Effect.annotateCurrentSpan("warehouse.backend", resolved.config.kind)
		yield* Effect.annotateCurrentSpan("warehouse.route", "ingest")
		yield* Effect.annotateCurrentSpan("warehouse.config_source", resolved.source)

		// Insert through the same client the read path uses (official
		// @clickhouse/client-web for ClickHouse, Tinybird Events API for
		// Tinybird) so the wire protocol is handled correctly — a hand-rolled
		// `?query=INSERT … FORMAT JSONEachRow` POST had its query param dropped
		// by managed ClickHouse, which then parsed the NDJSON body as SQL.
		const client = getCachedOrCreateClient(
			resolved.clientCacheKey,
			resolved.config,
			yield* Clock.currentTimeMillis,
		)
		const insertStartedAtMs = yield* Clock.currentTimeMillis

		yield* Effect.tryPromise({
			try: () => client.insert(datasource, rows),
			// Classify like the read path so an auth failure or quota breach on
			// insert surfaces with its real tag instead of a generic query error.
			catch: (error) => mapWarehouseError(label, error),
		}).pipe(
			Effect.tap(() =>
				Clock.currentTimeMillis.pipe(
					Effect.flatMap((completedAtMs) =>
						Effect.annotateCurrentSpan({
							"db.duration_ms": completedAtMs - insertStartedAtMs,
							"result.rowCount": rows.length,
						}),
					),
				),
			),
			Effect.tapError((error) =>
				Clock.currentTimeMillis.pipe(
					Effect.flatMap((completedAtMs) =>
						Effect.annotateCurrentSpan("db.duration_ms", completedAtMs - insertStartedAtMs),
					),
					Effect.andThen(
						Effect.logError("WarehouseQueryService.ingest failed", {
							datasource,
							rowCount: rows.length,
							backend: resolved.config.kind,
							errorTag: error._tag,
							message: error.message,
						}),
					),
				),
			),
			Effect.withSpan("WarehouseQueryService.insert", {
				kind: "client",
				attributes: {
					orgId: tenant.orgId,
					"tenant.userId": tenant.userId,
					"tenant.authMode": tenant.authMode,
					clientSource,
					"db.client": dialect.dbClient,
					"db.system.name": dialect.dbSystemName,
					"peer.service": dialect.peerService,
					"warehouse.backend": resolved.config.kind,
					"warehouse.route": "ingest",
					"warehouse.config_source": resolved.source,
					datasource,
				},
			}),
		)
	})

	// The facade only binds the tenant and defaults `query.context` — the
	// canonical `WarehouseQueryService.executeSql` span carries all
	// instrumentation, so no extra span layer is added here.
	const asExecutor = (tenant: ExecutionTenant): WarehouseExecutorShape => ({
		orgId: tenant.orgId,
		query: <T>(pipe: WarehouseQueryName, params: Record<string, unknown>, options?: SqlQueryOptions) =>
			query(tenant, { pipeName: pipe, params }, { context: `pipe:${pipe}`, ...options }).pipe(
				Effect.map((response) => ({ data: response.data as unknown as ReadonlyArray<T> })),
			),
		sqlQuery: <T>(sql: string, options?: SqlQueryOptions) =>
			sqlQuery(tenant, sql, { context: "warehouseExecutor.sqlQuery", ...options }).pipe(
				Effect.map((rows) => rows as unknown as ReadonlyArray<T>),
			),
		compiledQuery: <T>(compiled: CompiledQuery<T>, options?: SqlQueryOptions) =>
			compiledQuery(tenant, compiled, { context: "warehouseExecutor.compiledQuery", ...options }),
		compiledQueryFirst: <T>(compiled: CompiledQuery<T>, options?: SqlQueryOptions) =>
			compiledQueryFirst(tenant, compiled, {
				context: "warehouseExecutor.compiledQueryFirst",
				...options,
			}),
	})

	return {
		query,
		sqlQuery,
		rawSqlQuery,
		compiledQuery,
		compiledQueryFirst,
		ingest,
		asExecutor,
	} satisfies WarehouseQueryServiceShape
}
