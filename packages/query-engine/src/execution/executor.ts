import { Cause, Clock, Duration, Effect, HashMap, Option, Ref, Schedule, Schema } from "effect"
import {
	MAX_RAW_SQL_RESULT_BYTES,
	MAX_RAW_SQL_RESULT_ROWS,
	RawSqlValidationError,
	type WarehouseQueryRequest,
	WarehouseQueryResponse,
	WarehouseResultDecodeError,
	WarehouseScopeError,
	WarehouseUpstreamError,
	WarehouseValidationError,
} from "@maple/domain/http"
import type { WarehouseQueryName } from "@maple/domain/warehouse-queries"
import { compilePipeQuery, type CompiledQuery, type TenantScope } from "../ch"
import { parseStatement, withFormat, withSettings } from "@maple-dev/clickhouse-builder/sql"
import type { WarehouseExecutorApi } from "../observability"
import {
	settingsClause,
	type QueryProfileName,
	resolveSettings,
	stripTinybirdRestrictedSettings,
} from "../profiles"
import {
	mapWarehouseError,
	toWarehouseQueryError,
	type WarehouseExecutionError,
	type WarehouseReadExecutionError,
} from "./errors"
import { WarehouseResponseLimitError, type WarehouseResponseLimits } from "./response-limits"
import { SQL_LOG_MAX, SQL_TRACE_MAX, fingerprintSql, truncateSql } from "./fingerprint"
import { BackendDialect, warehouseTargetAttributes } from "./backend"
import { managedWarehouseCapabilities } from "./managed-capabilities"
import { resolveCompiledQuery } from "./compiled-input"
import { findIngestPinnedTable } from "./datasource-routing"
import type {
	CapabilityCompile,
	CompiledQueryInput,
	ExecutionTenant,
	ResolvedWarehouseConfig,
	RoutePurpose,
	SqlQueryOptions,
	WarehouseExecutorDeps,
	WarehouseQueryServiceApi,
	WarehouseSqlClient,
} from "./ports"
import {
	baselineWarehouseCapabilities,
	attributeIndexMode,
	deriveWarehouseCapabilities,
	logBodySearchMode,
	type WarehouseCapabilities,
	WarehouseColumnMetadataSchema,
	WarehouseIndexMetadataSchema,
	WarehouseSettingMetadataSchema,
	WarehouseVersionMetadataSchema,
} from "../capabilities"

const CLIENT_CACHE_TTL_MS = 30_000
/**
 * Only BYO ClickHouse is probed now, and its answer changes solely when the
 * user migrates their cluster. The cache is isolate-local (and there are two
 * per isolate), so the TTL — not the map — is what bounds probe volume.
 */
const CAPABILITIES_CACHE_TTL_MS = 60 * 60_000
const CAPABILITIES_INSPECTION_TIMEOUT = Duration.seconds(2)
const WarehouseCapabilityMetadataTarget = Schema.Literals(["version", "indexes", "columns", "settings"])
type WarehouseCapabilityMetadataTarget = Schema.Schema.Type<typeof WarehouseCapabilityMetadataTarget>

class WarehouseCapabilityProbeError extends Schema.TaggedError<WarehouseCapabilityProbeError>()(
	"@maple/query-engine/execution/WarehouseCapabilityProbeError",
	{
		target: WarehouseCapabilityMetadataTarget,
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

const CAPABILITY_AWARE_PIPES: ReadonlySet<string> = new Set([
	"list_logs",
	"logs_count",
	"list_traces",
	"custom_traces_timeseries",
	"custom_traces_breakdown",
])

interface CachedClient {
	client: WarehouseSqlClient
	cacheKey: string
	expiresAt: number
}

interface CachedCapabilities {
	readonly capabilities: WarehouseCapabilities
	readonly cacheKey: string
	readonly expiresAt: number
}

type TrustedSqlError = WarehouseReadExecutionError
type BoundedTrustedSqlError = TrustedSqlError | WarehouseResponseLimitError
type RawSqlError = WarehouseExecutionError | RawSqlValidationError

const sqlClientCacheKey = (config: ResolvedWarehouseConfig): string =>
	config.kind === "tinybird"
		? `tinybird:${config.host}:${config.token}`
		: `${config.kind}:${config.url}:${config.username}:${config.password}:${config.database}`

// Only retry transient upstream failures (5xx, 408, 429, network blips). Non-transient
// errors (auth, config, schema_drift, query) re-fail immediately — there's nothing to
// recover from by trying again. Caps at 2 retries (3 attempts total) to bound worst-case
// tail latency: at concurrency=4 in the alerting tick, a fully-degraded warehouse can
// still let the tick finish within its 60s window.
// `Schedule.max` recurs only while every schedule does, so `recurs(2)` is the cap.
const TRANSIENT_RETRY_SCHEDULE = Schedule.max([Schedule.exponential("100 millis", 2.0), Schedule.recurs(2)])

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
export const makeWarehouseExecutor = (deps: WarehouseExecutorDeps): WarehouseQueryServiceApi => {
	const clientCache = new Map<string, CachedClient>()
	const capabilitiesCache = Ref.makeUnsafe(HashMap.empty<string, CachedCapabilities>())

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

	const inspectCapabilities = (
		client: WarehouseSqlClient,
		allowSettingOverrides: boolean,
	): Effect.Effect<WarehouseCapabilities> => {
		const probeError = (target: WarehouseCapabilityMetadataTarget, cause: unknown) =>
			new WarehouseCapabilityProbeError({
				target,
				message: cause instanceof Error ? cause.message : String(cause),
				cause,
			})
		const queryRows = (target: WarehouseCapabilityMetadataTarget, sql: string) =>
			Effect.tryPromise({
				try: () => client.sql(parseStatement(sql)),
				catch: (cause) => probeError(target, cause),
			}).pipe(Effect.map((result) => result.data))
		const logProbeFailure = (error: WarehouseCapabilityProbeError) =>
			Effect.logWarning("Warehouse capability metadata probe failed").pipe(
				Effect.annotateLogs({
					target: error.target,
					error: error.message,
				}),
			)

		// Every probe degrades to an empty result rather than failing the whole
		// inspection. A backend that denies one `system.*` table (Tinybird answers
		// `403` for `system.columns` and `system.data_skipping_indices` but serves
		// `system.settings`) should lose only the features that depend on that
		// table: collapsing to `baselineWarehouseCapabilities()` silently disables
		// the bloom and tokenbf prefilters on a backend that does have them.
		const degradeToEmpty = <A>(
			effect: Effect.Effect<ReadonlyArray<A>, WarehouseCapabilityProbeError>,
		): Effect.Effect<ReadonlyArray<A>> =>
			effect.pipe(
				Effect.catchTag("@maple/query-engine/execution/WarehouseCapabilityProbeError", (error) =>
					logProbeFailure(error).pipe(Effect.as<ReadonlyArray<A>>([])),
				),
			)

		const inspection = Effect.all(
			[
				degradeToEmpty(
					queryRows("version", "SELECT version() AS version").pipe(
						Effect.flatMap((rows) =>
							Schema.decodeUnknownEffect(WarehouseVersionMetadataSchema)(rows),
						),
						Effect.catchTag("SchemaError", (cause) => Effect.fail(probeError("version", cause))),
					),
				),
				degradeToEmpty(
					queryRows(
						"indexes",
						`SELECT table, name, type, expr AS expression
FROM system.data_skipping_indices
WHERE database = currentDatabase() AND table IN ('logs', 'traces')`,
					).pipe(
						Effect.flatMap((rows) =>
							Schema.decodeUnknownEffect(WarehouseIndexMetadataSchema)(rows),
						),
						Effect.catchTag("SchemaError", (cause) => Effect.fail(probeError("indexes", cause))),
					),
				),
				degradeToEmpty(
					queryRows(
						"columns",
						`SELECT table, name
FROM system.columns
WHERE database = currentDatabase() AND table IN ('logs', 'traces')`,
					).pipe(
						Effect.flatMap((rows) =>
							Schema.decodeUnknownEffect(WarehouseColumnMetadataSchema)(rows),
						),
						Effect.catchTag("SchemaError", (cause) => Effect.fail(probeError("columns", cause))),
					),
				),
				degradeToEmpty(
					queryRows(
						"settings",
						`SELECT name, value
FROM system.settings
WHERE name = 'enable_full_text_index'`,
					).pipe(
						Effect.flatMap((rows) =>
							Schema.decodeUnknownEffect(WarehouseSettingMetadataSchema)(rows),
						),
						Effect.catchTag("SchemaError", (cause) => Effect.fail(probeError("settings", cause))),
					),
				),
			],
			{ concurrency: "unbounded" },
		).pipe(
			Effect.map(([versions, indexes, columns, settings]) =>
				deriveWarehouseCapabilities({
					serverVersion: versions[0]?.version,
					indexes,
					columns,
					settings,
					allowSettingOverrides,
				}),
			),
		)

		// Individual probe failures are already absorbed by `degradeToEmpty`, so
		// only a whole-inspection timeout can still reach the conservative plan.
		const timed: Effect.Effect<WarehouseCapabilities, Cause.TimeoutError> = inspection.pipe(
			Effect.timeout(CAPABILITIES_INSPECTION_TIMEOUT),
		)
		return timed.pipe(
			Effect.catchTag("TimeoutError", (error) =>
				Effect.logWarning("Warehouse capability inspection fell back to conservative plan").pipe(
					Effect.annotateLogs({ target: "inspection", error: error.message }),
					Effect.as(baselineWarehouseCapabilities()),
				),
			),
		)
	}

	const resolveCapabilities = Effect.fn("WarehouseQueryService.resolveCapabilities")(function* (
		tenant: ExecutionTenant,
		options?: SqlQueryOptions,
	) {
		const purpose: "read" | "ingest" = options?.route === "ingest" ? "ingest" : "read"
		const resolved = yield* deps.resolveRoute(tenant, purpose, "capabilities")

		// Backends running the schema we deploy answer from the generated
		// snapshot: no client, no round-trip, no cache entry, and no way to fall
		// back to a conservative plan because a `system.*` probe was denied.
		if (BackendDialect[resolved.config.kind].managedSchema) {
			const capabilities = managedWarehouseCapabilities()
			yield* Effect.annotateCurrentSpan({
				"maple.query.capabilities.cache": "static",
				"maple.query.capabilities.metadata_available": capabilities.metadataAvailable,
				"warehouse.backend": resolved.config.kind,
				"warehouse.route": purpose,
				"warehouse.config_source": resolved.source,
				orgId: tenant.orgId,
			})
			return capabilities
		}

		const nowMs = yield* Clock.currentTimeMillis
		const configKey = sqlClientCacheKey(resolved.config)
		const cache = yield* Ref.get(capabilitiesCache)
		const cached = Option.getOrUndefined(HashMap.get(cache, resolved.clientCacheKey))
		if (cached && cached.cacheKey === configKey && cached.expiresAt > nowMs) {
			yield* Effect.annotateCurrentSpan({
				"maple.query.capabilities.cache": "hit",
				"maple.query.capabilities.metadata_available": cached.capabilities.metadataAvailable,
			})
			return cached.capabilities
		}

		const dialect = BackendDialect[resolved.config.kind]
		// This executor is Worker-isolate scoped. Do not share an in-flight
		// Deferred between capability probes: its leader can own Cloudflare I/O
		// that a follower request is forbidden to await. The completed
		// capabilities are plain data and remain safe to cache across requests.
		const capabilities = yield* inspectCapabilities(
			getCachedOrCreateClient(resolved.clientCacheKey, resolved.config, nowMs),
			!dialect.stripTinybirdRestrictedSettings,
		).pipe(
			Effect.tap((result) =>
				Ref.update(capabilitiesCache, (current) =>
					HashMap.set(current, resolved.clientCacheKey, {
						capabilities: result,
						cacheKey: configKey,
						expiresAt: nowMs + CAPABILITIES_CACHE_TTL_MS,
					}),
				),
			),
			Effect.withSpan("WarehouseQueryService.inspectCapabilities", {
				kind: "client",
				attributes: {
					orgId: tenant.orgId,
					"db.client": dialect.dbClient,
					"db.system.name": dialect.dbSystemName,
					"peer.service": dialect.peerService,
					...warehouseTargetAttributes(resolved.config),
					"warehouse.backend": resolved.config.kind,
					"warehouse.route": purpose,
					"warehouse.config_source": resolved.source,
					"maple.query.capabilities.cache": "miss",
				},
			}),
		)
		yield* Effect.annotateCurrentSpan({
			"maple.query.capabilities.cache": "miss",
			"maple.query.capabilities.metadata_available": capabilities.metadataAvailable,
			"warehouse.backend": resolved.config.kind,
			"warehouse.route": purpose,
			"warehouse.config_source": resolved.source,
			orgId: tenant.orgId,
		})
		return capabilities
	})

	// Client-kind is load-bearing: the service-map DB-edge MV
	// (service_map_db_edges_hourly_mv) only counts SpanKind IN ('Client','Producer').
	const executeSqlOnceEffect = Effect.fn("WarehouseQueryService.executeSql", { kind: "client" })(function* (
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options?: SqlQueryOptions,
		execution: "trusted" | "raw" = "trusted",
		responseLimits?: WarehouseResponseLimits,
	) {
		const startedAtMs = yield* Clock.currentTimeMillis
		yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
		yield* Effect.annotateCurrentSpan("tenant.userId", tenant.userId)
		yield* Effect.annotateCurrentSpan("tenant.authMode", tenant.authMode)
		// Identify the query BEFORE anything that can block. `resolveRoute` below
		// reads org config from Postgres and has been observed consuming a whole
		// 30s request budget; annotating after it left those spans with no
		// `query.context`, no `db.query.text` and no fingerprint — i.e. the slowest
		// queries in the system were the only ones we couldn't identify. `db.query.*`
		// still lands later because the final SQL isn't known until settings are
		// applied, but the label and pipe are known right here.
		yield* Effect.annotateCurrentSpan("query.pipe", pipe)
		// Always set, never conditionally: an absent attribute is indistinguishable
		// from an unlabeled call site. `pipe` is the fallback label.
		yield* Effect.annotateCurrentSpan("query.context", options?.context ?? pipe)
		if (options?.profile) yield* Effect.annotateCurrentSpan("query.profile", options.profile)

		// `compile()` now refuses to leave a placeholder behind, so this only fires
		// for SQL that reached the executor without going through it — a raw
		// template, or a splice compiled with `deferParams` that nothing resolved.
		const leftoverParam = sql.match(/__PARAM_[A-Za-z]+_(\w+)__/)
		if (leftoverParam) {
			// An unresolved param is a compile-time bug in Maple's query construction,
			// not a recoverable runtime failure — surface it as a defect.
			return yield* Effect.die(
				new Error(
					`Compiled SQL contains unresolved param '${leftoverParam[1]}' — the query declared it but the runtime params object did not provide it`,
				),
			)
		}

		// Control-plane datasources (e.g. alert_checks) are written via `ingest`,
		// which is hard-pinned to the managed Tinybird pipeline. They do NOT exist
		// in a per-org BYO ClickHouse, so their reads must route to the same ingest
		// config to stay symmetric with the write — otherwise a BYO-CH org reads an
		// empty table from its own ClickHouse. That routing is declared at the
		// query definition (`.route("ingest")` → `options.route`).
		const purpose: RoutePurpose =
			execution === "raw" ? "raw" : options?.route === "ingest" ? "ingest" : "read"
		const resolved = yield* deps.resolveRoute(tenant, purpose, pipe)
		// Safety net for the silent-empty-table failure: an ingest-pinned table
		// read against an org's own BYO ClickHouse returns no rows, not an error.
		if (purpose !== "ingest" && resolved.source === "org-byo") {
			const pinnedTable = findIngestPinnedTable(sql)
			if (pinnedTable !== undefined) {
				yield* Effect.logWarning(
					'Query reads an ingest-pinned datasource from a BYO ClickHouse — declare .route("ingest") at the query definition',
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
		// Target identity, so a read joins the same service-map node the ingest
		// gateway writes to instead of collapsing into a nameless per-system one.
		yield* Effect.annotateCurrentSpan(warehouseTargetAttributes(resolved.config))
		const settings = dialect.stripTinybirdRestrictedSettings
			? stripTinybirdRestrictedSettings(resolveSettings(options))
			: resolveSettings(options)
		// Parsed once here and passed to the driver as a statement, so no driver
		// re-derives from SQL text which terminal clauses it already carries.
		const parsed = parseStatement(sql)
		const statement = withFormat(
			withSettings(parsed, parsed.settings ?? settingsClause(settings)),
			dialect.wireFormat === "in-statement" ? (parsed.format ?? dialect.statementFormat) : undefined,
		)
		const finalSql = statement.text
		const sqlLength = finalSql.length
		const sqlTruncated = sqlLength > SQL_TRACE_MAX
		yield* Effect.annotateCurrentSpan("db.query.text", truncateSql(finalSql, SQL_TRACE_MAX))
		yield* Effect.annotateCurrentSpan("db.query.length", sqlLength)
		yield* Effect.annotateCurrentSpan("db.query.truncated", sqlTruncated)
		// Fingerprint the body, not the rendered statement: SETTINGS and FORMAT
		// vary with the backend and the cost profile, and hashing them forks one
		// query into several shapes in the query-shape rollup, which keys on this.
		yield* Effect.annotateCurrentSpan("db.query.fingerprint", fingerprintSql(statement.body))
		if (settings) yield* Effect.annotateCurrentSpan("ch.settings", JSON.stringify(settings))

		const client = getCachedOrCreateClient(
			resolved.clientCacheKey,
			resolved.config,
			yield* Clock.currentTimeMillis,
		)
		const attemptTimeoutMs = clientTimeoutMs(options?.profile, settings?.maxExecutionTime)
		const retryAttempts = yield* Ref.make(0)
		// A caller-supplied budget wins: a trusted query that knows its own response
		// can blow the Worker heap (session replay's rrweb payloads) opts in
		// explicitly. Raw SQL keeps its standing caps.
		const effectiveResponseLimits =
			responseLimits ??
			(execution === "raw"
				? { maxRows: MAX_RAW_SQL_RESULT_ROWS, maxBytes: MAX_RAW_SQL_RESULT_BYTES }
				: undefined)
		const queryAttempt = Effect.tryPromise({
			try: () =>
				client.sql(
					statement,
					effectiveResponseLimits === undefined
						? undefined
						: { responseLimits: effectiveResponseLimits },
				),
			catch: (error) =>
				error instanceof WarehouseResponseLimitError
					? // Only raw SQL restates this as a validation error — there the
						// oversized result IS the caller's query problem. For a trusted
						// query the limit is ours, so it propagates unchanged and the
						// caller maps it to a domain error. Either way it never becomes a
						// WarehouseUpstreamError, so the transient retry loop skips it
						// instead of re-running a read that already exhausted the heap.
						execution === "raw"
						? new RawSqlValidationError({ code: "ResourceLimit", message: error.message })
						: error
					: // `execution` decides authorship: raw SQL comes from the caller (the
						// raw_sql widget, the `run_sql` MCP tool), so an analyzer complaint
						// about it is their typo and must keep the database's own message.
						mapWarehouseError(pipe, error, execution === "raw" ? "caller" : "maple"),
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

	function executeSqlOnce(
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options: SqlQueryOptions | undefined,
		execution: "trusted",
		responseLimits?: undefined,
	): Effect.Effect<ReadonlyArray<Record<string, unknown>>, TrustedSqlError>
	function executeSqlOnce(
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options: SqlQueryOptions | undefined,
		execution: "trusted",
		responseLimits: WarehouseResponseLimits,
	): Effect.Effect<ReadonlyArray<Record<string, unknown>>, BoundedTrustedSqlError>
	function executeSqlOnce(
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options: SqlQueryOptions | undefined,
		execution: "raw",
		responseLimits?: undefined,
	): Effect.Effect<ReadonlyArray<Record<string, unknown>>, RawSqlError>
	function executeSqlOnce(
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options: SqlQueryOptions | undefined,
		execution: "trusted" | "raw",
		responseLimits?: WarehouseResponseLimits,
	): Effect.Effect<ReadonlyArray<Record<string, unknown>>, BoundedTrustedSqlError | RawSqlError>
	function executeSqlOnce(
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options: SqlQueryOptions | undefined,
		execution: "trusted" | "raw",
		responseLimits?: WarehouseResponseLimits,
	): Effect.Effect<ReadonlyArray<Record<string, unknown>>, BoundedTrustedSqlError | RawSqlError> {
		return executeSqlOnceEffect(tenant, sql, pipe, options, execution, responseLimits)
	}

	/**
	 * `executeSqlOnce`, plus a single self-heal retry when the warehouse rejects
	 * our credentials.
	 *
	 * The host caches per-org routing config and tolerates it being stale, which
	 * is right for a row that only changes on BYO-ClickHouse onboarding and
	 * credential rotation — but it means a rotation resolves to the retired
	 * password until the cached entry ages out. `deps.invalidateRoute` drops that
	 * entry and reports whether an org override was actually in play; only then
	 * is re-running worthwhile, because a `WarehouseAuthError` on the shared
	 * managed credential resolves to the same bad credential the second time.
	 *
	 * Exactly one retry, and only for auth: the second attempt reads config the
	 * first attempt just invalidated, so if that still fails the credentials are
	 * genuinely wrong and looping would only multiply the failure. `Effect.retry`
	 * is deliberately not used — the recovery is the invalidation, not the delay.
	 *
	 * The annotation lands on the *caller's* span rather than either
	 * `executeSql` span, so one logical query that self-healed reads as one
	 * flagged operation. A non-zero rate here that doesn't line up with a
	 * rotation means the staleness window is too long.
	 */
	const executeSqlEffect = (
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options?: SqlQueryOptions,
		execution: "trusted" | "raw" = "trusted",
		responseLimits?: WarehouseResponseLimits,
	) => {
		const attempt = executeSqlOnce(tenant, sql, pipe, options, execution, responseLimits)
		const invalidateRoute = deps.invalidateRoute
		if (invalidateRoute === undefined) return attempt
		return attempt.pipe(
			Effect.catchTag("@maple/http/errors/WarehouseAuthError", (error) =>
				invalidateRoute(tenant).pipe(
					Effect.flatMap((invalidated) =>
						invalidated
							? Effect.annotateCurrentSpan("warehouse.config.auth_retry", true).pipe(
									Effect.andThen(
										executeSqlOnce(tenant, sql, pipe, options, execution, responseLimits),
									),
								)
							: Effect.fail(error),
					),
				),
			),
		)
	}

	function executeSql(
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options: SqlQueryOptions | undefined,
		execution: "trusted",
		responseLimits?: undefined,
	): Effect.Effect<ReadonlyArray<Record<string, unknown>>, TrustedSqlError>
	function executeSql(
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options: SqlQueryOptions | undefined,
		execution: "trusted",
		responseLimits: WarehouseResponseLimits,
	): Effect.Effect<ReadonlyArray<Record<string, unknown>>, BoundedTrustedSqlError>
	function executeSql(
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options: SqlQueryOptions | undefined,
		execution: "raw",
		responseLimits?: undefined,
	): Effect.Effect<ReadonlyArray<Record<string, unknown>>, RawSqlError>
	function executeSql(
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options: SqlQueryOptions | undefined,
		execution: "trusted" | "raw",
		responseLimits?: WarehouseResponseLimits,
	): Effect.Effect<ReadonlyArray<Record<string, unknown>>, BoundedTrustedSqlError | RawSqlError>
	function executeSql(
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options: SqlQueryOptions | undefined,
		execution: "trusted" | "raw",
		responseLimits?: WarehouseResponseLimits,
	): Effect.Effect<ReadonlyArray<Record<string, unknown>>, BoundedTrustedSqlError | RawSqlError> {
		return executeSqlEffect(tenant, sql, pipe, options, execution, responseLimits)
	}

	const executeTrustedSql = (
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options?: SqlQueryOptions,
	): Effect.Effect<ReadonlyArray<Record<string, unknown>>, TrustedSqlError> =>
		executeSql(tenant, sql, pipe, options, "trusted")

	const executeTrustedSqlBounded = (
		tenant: ExecutionTenant,
		sql: string,
		pipe: string,
		options: SqlQueryOptions | undefined,
		responseLimits: WarehouseResponseLimits,
	): Effect.Effect<ReadonlyArray<Record<string, unknown>>, BoundedTrustedSqlError> =>
		executeSql(tenant, sql, pipe, options, "trusted", responseLimits)

	const withCapabilitySettings = (
		capabilities: WarehouseCapabilities | undefined,
		options?: SqlQueryOptions,
	): SqlQueryOptions | undefined =>
		capabilities?.fullTextSearchSetting === "available"
			? {
					...options,
					settings: { ...options?.settings, enableFullTextIndex: 1 },
				}
			: options

	const annotateCapabilityPlan = (capabilities: WarehouseCapabilities) =>
		Effect.annotateCurrentSpan({
			"maple.query.capabilities.metadata_available": capabilities.metadataAvailable,
			"maple.query.plan.log_body": logBodySearchMode(capabilities),
			"maple.query.plan.log_attributes": attributeIndexMode(capabilities, "logs"),
			"maple.query.plan.trace_attributes": attributeIndexMode(capabilities, "traces"),
			"maple.query.plan.full_text_setting": capabilities.fullTextSearchSetting,
		})

	const query = Effect.fn("WarehouseQueryService.query")(function* (
		tenant: ExecutionTenant,
		payload: WarehouseQueryRequest,
		options?: SqlQueryOptions,
	) {
		yield* Effect.annotateCurrentSpan("pipe", payload.pipeName)
		yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)

		if (!tenant.orgId || tenant.orgId.trim() === "") {
			return yield* new WarehouseScopeError({
				pipeName: payload.pipeName,
				message: "org_id must not be empty",
			})
		}

		const capabilities = CAPABILITY_AWARE_PIPES.has(payload.pipeName)
			? yield* resolveCapabilities(tenant, options)
			: undefined
		if (capabilities) yield* annotateCapabilityPlan(capabilities)
		const lowered = compilePipeQuery(
			payload.pipeName,
			{
				...payload.params,
				org_id: tenant.orgId,
			},
			capabilities ?? baselineWarehouseCapabilities(),
		)

		if (!lowered) {
			return yield* new WarehouseValidationError({
				message: `Unsupported pipe: ${payload.pipeName}`,
				pipeName: payload.pipeName,
			})
		}

		// The pipe params come off the wire, so a value the query cannot encode is
		// the caller's problem to hear about — the one compile path in the product
		// where that is true, and the reason it reports rather than crashes.
		const compiled = yield* lowered.pipe(
			Effect.mapError(
				(error) =>
					new WarehouseValidationError({
						message: `Could not compile pipe ${payload.pipeName}: ${error.message}`,
						pipeName: payload.pipeName,
					}),
			),
		)

		// The pipe path used to call `executeTrustedSql` directly, with no scope
		// assertion of any kind — it relied on `compilePipeQuery` always threading
		// `org_id`. Same gate as the compiled path now.
		const rows = yield* executeScopedSql(
			tenant,
			compiled.sql,
			compiled.tenantScope,
			payload.pipeName,
			withCapabilitySettings(capabilities, options),
		)
		const decodedRows = yield* compiled.decodeRows(rows).pipe(
			Effect.mapError(
				(error) =>
					new WarehouseResultDecodeError({
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

	/**
	 * Run SQL that a `CompiledQuery` has already vouched for.
	 *
	 * Callers must pass the compiled query's `tenantScope`, not a string they
	 * assembled themselves. The old gate here was `sql.includes("OrgId")`, which
	 * `SELECT count() AS OrgId …` and `WHERE OrgId = 'x' OR 1=1` both satisfy —
	 * so scoping is now decided by the builder when it sees an `OrgId` predicate
	 * in a top-level WHERE, and this only enforces the decision.
	 */
	const validateTenantScope = Effect.fn("WarehouseQueryService.validateTenantScope")(function* (
		tenant: ExecutionTenant,
		tenantScope: TenantScope,
		context: string,
	) {
		if (!tenant.orgId || tenant.orgId.trim() === "") {
			return yield* new WarehouseScopeError({
				pipeName: context,
				message: `org_id must not be empty (${context})`,
			})
		}
		if (tenantScope !== "single-tenant") {
			return yield* new WarehouseScopeError({
				pipeName: context,
				message:
					`compiled query is not tenant-scoped: no top-level OrgId predicate (${context}). ` +
					`Deliberate cross-tenant reads must declare .crossTenant() and run through crossOrgQuery.`,
			})
		}
	})

	const executeScopedSql = Effect.fn("WarehouseQueryService.executeScopedSql")(function* (
		tenant: ExecutionTenant,
		sql: string,
		tenantScope: TenantScope,
		context: string,
		options?: SqlQueryOptions,
	) {
		yield* validateTenantScope(tenant, tenantScope, context)
		return yield* executeTrustedSql(tenant, sql, context, options)
	})

	const executeScopedSqlBounded = Effect.fn("WarehouseQueryService.executeScopedSqlBounded")(function* (
		tenant: ExecutionTenant,
		sql: string,
		tenantScope: TenantScope,
		context: string,
		options: SqlQueryOptions | undefined,
		responseLimits: WarehouseResponseLimits,
	) {
		yield* validateTenantScope(tenant, tenantScope, context)
		return yield* executeTrustedSqlBounded(tenant, sql, context, options, responseLimits)
	})

	const rawSqlQuery = Effect.fn("WarehouseQueryService.rawSqlQuery")(function* (
		tenant: ExecutionTenant,
		sql: string,
		options?: Pick<SqlQueryOptions, "profile" | "context">,
	) {
		// No OrgId assertion here on purpose. This path runs user-authored SQL,
		// whose isolation is enforced upstream at the credential layer — a
		// per-org datasource-scoped JWT on managed Tinybird, the org's own
		// cluster credentials on BYO ClickHouse. `prepareRawSql` has already
		// expanded and validated `$__orgFilter`; a substring check on top of that
		// asserts nothing and invites the belief that it does.
		return yield* executeSql(tenant, sql, "rawSqlQuery", options, "raw")
	})

	// A compiled query can carry `.route("ingest")` from its definition — that
	// wins over the (absent) per-call option so the table→routing knowledge
	// lives next to the query, not at every call site.
	const withCompiledRouting = <T>(
		compiled: CompiledQuery<T>,
		options?: SqlQueryOptions,
	): SqlQueryOptions | undefined =>
		compiled.route === "ingest" ? { ...options, route: "ingest" } : options

	// Every compiled query runs under a cost profile: an omitted `profile` used to
	// mean "no SETTINGS clause at all" (no server-side memory/time budget, flat
	// 30s client cap), which ~20 call sites hit by accident. Default to
	// "aggregation" like the QuerySpec lowering does; "unbounded" stays the
	// explicit opt-out.
	const withDefaultProfile = (options?: SqlQueryOptions): SqlQueryOptions => ({
		...options,
		profile: options?.profile ?? "aggregation",
	})

	/** `resolveCompiledQuery`, plus the capability-aware form only this port has. */
	const resolveCompiled = <T>(
		compiled: CompiledQueryInput<T> | CapabilityCompile<T>,
		capabilities: WarehouseCapabilities | undefined,
	): Effect.Effect<CompiledQuery<T>> =>
		typeof compiled === "function"
			? Effect.orDie(compiled(capabilities!))
			: resolveCompiledQuery(compiled)

	const executeCompiledQuery = Effect.fn("WarehouseQueryService.executeCompiledQuery")(function* <T>(
		tenant: ExecutionTenant,
		compiled: CompiledQueryInput<T> | CapabilityCompile<T>,
		rawOptions?: SqlQueryOptions,
	) {
		const options = withDefaultProfile(rawOptions)
		const capabilities =
			typeof compiled === "function" ? yield* resolveCapabilities(tenant, options) : undefined
		if (capabilities) yield* annotateCapabilityPlan(capabilities)
		const selected = yield* resolveCompiled<T>(compiled, capabilities)
		const executionOptions = withCapabilitySettings(capabilities, options)
		yield* Effect.annotateCurrentSpan(
			"query.optimization.capabilityAware",
			typeof compiled === "function",
		)
		const rows = yield* executeScopedSql(
			tenant,
			selected.sql,
			selected.tenantScope,
			options.context ?? "compiledQuery",
			withCompiledRouting(selected, executionOptions),
		)
		return yield* selected.decodeRows(rows).pipe(
			Effect.mapError(
				(error) =>
					new WarehouseResultDecodeError({
						pipeName: options.context ?? "compiledQuery",
						message: error.message,
						cause: error,
					}),
			),
		)
	})

	const compiledQuery = (<T>(
		tenant: ExecutionTenant,
		compiled: CompiledQueryInput<T> | CapabilityCompile<T>,
		options?: SqlQueryOptions,
	) => executeCompiledQuery(tenant, compiled, options)) as WarehouseQueryServiceApi["compiledQuery"]

	/**
	 * Read with an explicit ceiling on the response we're willing to materialize.
	 *
	 * The limit error propagates to the caller instead of being retried: it is a
	 * statement about the size of the answer, so re-running the query produces
	 * the same oversized response. Callers map it to a domain error that tells
	 * the user to ask for less.
	 */
	const compiledQueryBounded = Effect.fn("WarehouseQueryService.compiledQueryBounded")(function* <T>(
		tenant: ExecutionTenant,
		input: CompiledQueryInput<T>,
		options: SqlQueryOptions & {
			readonly responseLimits: WarehouseResponseLimits
		},
	) {
		const { responseLimits, ...queryOptions } = options
		const normalizedOptions = withDefaultProfile(queryOptions)
		const context = normalizedOptions.context ?? "compiledQueryBounded"
		const compiled = yield* resolveCompiled<T>(input, undefined)
		const rows = yield* executeScopedSqlBounded(
			tenant,
			compiled.sql,
			compiled.tenantScope,
			context,
			withCompiledRouting(compiled, normalizedOptions),
			responseLimits,
		)
		return yield* compiled.decodeRows(rows).pipe(
			Effect.mapError(
				(error) =>
					new WarehouseResultDecodeError({
						pipeName: context,
						message: error.message,
						cause: error,
					}),
			),
		)
	})

	const compiledQueryWithCapabilities = <T>(
		tenant: ExecutionTenant,
		compile: CapabilityCompile<T>,
		options?: SqlQueryOptions,
	) => executeCompiledQuery(tenant, compile, options)

	/**
	 * Deliberately read across every tenant.
	 *
	 * A separate method rather than a flag on `compiledQuery`, so that grepping
	 * for cross-tenant reads returns a finite, reviewable list. The compiled
	 * query must have declared `.crossTenant()`; a scoped query arriving here is
	 * just as much a bug as an unscoped one on the normal path, so both
	 * directions are rejected.
	 */
	const crossOrgQuery = Effect.fn("WarehouseQueryService.crossOrgQuery")(function* <T>(
		tenant: ExecutionTenant,
		input: CompiledQueryInput<T>,
		rawOptions: SqlQueryOptions & { readonly justification: string },
	) {
		const options = withDefaultProfile(rawOptions)
		const context = options.context ?? "crossOrgQuery"
		const compiled = yield* resolveCompiled<T>(input, undefined)
		if (compiled.tenantScope !== "cross-tenant") {
			return yield* new WarehouseScopeError({
				pipeName: context,
				message:
					`tenant-scoped query routed through crossOrgQuery (${context}). ` +
					`Use compiledQuery — the cross-org path skips scope enforcement.`,
			})
		}
		// Annotated so "who reads across tenants, and why" is answerable from the
		// traces themselves rather than from code review alone.
		yield* Effect.annotateCurrentSpan("tenant.scope", "cross-org")
		yield* Effect.annotateCurrentSpan("tenant.crossOrg.justification", rawOptions.justification)
		const rows = yield* executeTrustedSql(
			tenant,
			compiled.sql,
			context,
			withCompiledRouting(compiled, options),
		)
		return yield* compiled.decodeRows(rows).pipe(
			Effect.mapError(
				(error) =>
					new WarehouseResultDecodeError({
						pipeName: context,
						message: error.message,
						cause: error,
					}),
			),
		)
	})

	const compiledQueryFirst = Effect.fn("WarehouseQueryService.compiledQueryFirst")(function* <T>(
		tenant: ExecutionTenant,
		compiled: CompiledQueryInput<T> | CapabilityCompile<T>,
		rawOptions?: SqlQueryOptions,
	) {
		const options = withDefaultProfile(rawOptions)
		const capabilities =
			typeof compiled === "function" ? yield* resolveCapabilities(tenant, options) : undefined
		if (capabilities) yield* annotateCapabilityPlan(capabilities)
		const selected = yield* resolveCompiled<T>(compiled, capabilities)
		const executionOptions = withCapabilitySettings(capabilities, options)
		yield* Effect.annotateCurrentSpan(
			"query.optimization.capabilityAware",
			typeof compiled === "function",
		)
		const rows = yield* executeScopedSql(
			tenant,
			selected.sql,
			selected.tenantScope,
			options.context ?? "compiledQueryFirst",
			withCompiledRouting(selected, executionOptions),
		)
		return yield* selected.decodeFirstRow(rows).pipe(
			Effect.mapError(
				(error) =>
					new WarehouseResultDecodeError({
						pipeName: options.context ?? "compiledQueryFirst",
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
			// Authorship stays the default "caller": inserts are not DSL-generated
			// SQL, and a rejection here usually means the rows are wrong, not that
			// Maple composed a bad statement.
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
					...warehouseTargetAttributes(resolved.config),
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
	const asExecutor = (tenant: ExecutionTenant): WarehouseExecutorApi => ({
		orgId: tenant.orgId,
		query: <T>(pipe: WarehouseQueryName, params: Record<string, unknown>, options?: SqlQueryOptions) =>
			query(tenant, { pipeName: pipe, params }, { context: `pipe:${pipe}`, ...options }).pipe(
				Effect.map((response) => ({ data: response.data as ReadonlyArray<T> })),
			),
		compiledQuery: <T>(compiled: CompiledQueryInput<T>, options?: SqlQueryOptions) =>
			compiledQuery(tenant, compiled, { context: "warehouseExecutor.compiledQuery", ...options }),
		compiledQueryFirst: <T>(compiled: CompiledQueryInput<T>, options?: SqlQueryOptions) =>
			compiledQueryFirst(tenant, compiled, {
				context: "warehouseExecutor.compiledQueryFirst",
				...options,
			}),
	})

	return {
		query,
		crossOrgQuery: (tenant, compiled, options) => crossOrgQuery(tenant, compiled, options),
		rawSqlQuery,
		compiledQuery,
		compiledQueryBounded,
		compiledQueryWithCapabilities,
		compiledQueryFirst,
		// `resolveCapabilities` resolves the route on its way through, so warming
		// it warms both. `ignore` keeps a failed warm-up invisible — the real
		// query behind it fails with its own context a moment later.
		warmRoute: (tenant, options) =>
			resolveCapabilities(tenant, options).pipe(
				Effect.asVoid,
				Effect.ignore,
				Effect.withSpan("WarehouseQueryService.warmRoute", {
					attributes: { orgId: tenant.orgId },
				}),
			),
		ingest,
		asExecutor,
	} satisfies WarehouseQueryServiceApi
}
