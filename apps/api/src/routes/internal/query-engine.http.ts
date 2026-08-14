import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	MapleInternalApi,
	RawSqlExecuteResponse,
	type RawSqlValidationError,
	SpanHierarchyResponse,
	SpanDetailResponse,
	ErrorsByTypeResponse,
	ErrorsTimeseriesResponse,
	ErrorsSummaryResponse,
	ErrorDetailTracesResponse,
	ErrorRateByServiceResponse,
	ServiceOverviewResponse,
	ServiceHealthSnapshotResponse,
	ServiceHealthBaselineResponse,
	ServiceApdexResponse,
	PlanetScaleInfraTimeseriesResponse,
	ServiceCloudflareStatsResponse,
	ServicePlanetScaleStatsResponse,
	CloudflareInfraZonesResponse,
	CloudflareInfraZoneTimeseriesResponse,
	CloudflareInfraZoneDetailResponse,
	CloudflareInfraZoneSecurityResponse,
	CloudflareInfraZoneBreakdownResponse,
	CloudflareInfraZoneDnsResponse,
	CloudflareInfraZoneFacetsResponse,
	CloudflareInfraPlatformResourcesResponse,
	CloudflareInfraWorkersResponse,
	ServiceDbQuerySummaryResponse,
	ServiceDetailOverviewResponse,
	ServiceDependenciesBundleResponse,
	ServiceMapBundleResponse,
	ServiceWorkloadsResponse,
	ServiceUsageResponse,
	ServiceOperationsResponse,
	ServiceEndpointsResponse,
	EndpointStatusBreakdownResponse,
	ListLogsResponse,
	GetLogResponse,
	ListMetricsResponse,
	MetricsSummaryResponse,
	ListHostsResponse,
	HostDetailSummaryResponse,
	HostInfraTimeseriesResponse,
	FleetUtilizationTimeseriesResponse,
	ListPodsResponse,
	PodsSummaryResponse,
	PodDetailSummaryResponse,
	PodInfraTimeseriesResponse,
	PodFacetsResponse,
	ListNodesResponse,
	NodeDetailSummaryResponse,
	NodeInfraTimeseriesResponse,
	NodeFacetsResponse,
	ListWorkloadsResponse,
	WorkloadDetailSummaryResponse,
	WorkloadInfraTimeseriesResponse,
	WorkloadFacetsResponse,
	WebAnalyticsSummaryResponse,
	WebAnalyticsTimeseriesResponse,
	WebAnalyticsPageviewsResponse,
	WebAnalyticsPagesResponse,
	WebAnalyticsBreakdownsResponse,
	CommitSha,
	FingerprintHash,
	ServiceName,
	SpanName,
	StatusCode,
	TraceId,
	SpanId,
} from "@maple/domain/http"
import { Clock, Effect, Match, Option, Schema } from "effect"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"
import { makeDirectRouteCachePolicy, makeExecuteRawSql } from "@maple/query-engine/runtime"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { traceCacheTtlSeconds } from "@/services/warehouse/trace-detail-cache"
import {
	CH,
	computeBucketSecondsForRange,
	formatWarehouseDateTime,
	parseWarehouseDateTime,
	QueryEngineExecuteBatchResponse,
} from "@maple/query-engine"
import { LOGS_BODY_SEARCH_SETTINGS } from "@maple/query-engine/profiles"
import {
	hostMetricSpec,
	nodeMetricSpec,
	partitionWindowAround,
	podMetricSpec,
	toCloudflareFilters,
	workloadMetricSpec,
} from "@/routes/query-helpers"
import { Queries } from "@/routes/queries"
import { makeQueryRunners } from "@/routes/query-runner"
import { runQueryEngineBatch } from "@/routes/query-engine-batch"
import type { ExecutionTenant, WarehouseExecutionError } from "@maple/query-engine/execution"
import type { TenantContext } from "@/services/auth/AuthService"
import * as Integrations from "@maple/query-engine-integrations"

// `warehouse.sqlQuery` fails with the warehouse error union (distinct tagged
// classes per failure mode). The typed error channel threads through unchanged
// so HTTP status mapping stays accurate — every endpoint declares the full set
// via `warehouseHttpErrors`; on failure the context string lands on the route
// span so a failed request names which sub-query broke.
const mapExecError = <A, E, R>(effect: Effect.Effect<A, E, R>, context: string): Effect.Effect<A, E, R> =>
	effect.pipe(
		Effect.tapError(() => Effect.annotateCurrentSpan({ "maple.query_engine.failed_step": context })),
	)

/**
 * Payload → query-engine filter opts. Every Cloudflare zone endpoint carries the same optional
 * filter bag, and which of them a given panel can honor depends on the metric families it reads —
 * `Integrations.cloudflareIgnoredFiltersFor` answers that, and the answer ships in the response so the UI can
 * mark a panel zone-wide instead of pretending the filter applied.
 */

const isMissingServiceOperationsRollup = (error: unknown): boolean => {
	if (typeof error !== "object" || error === null) return false
	const candidate = error as {
		readonly _tag?: unknown
		readonly clickhouseType?: unknown
		readonly message?: unknown
	}
	return (
		candidate._tag === "@maple/http/errors/WarehouseConfigError" &&
		(candidate.clickhouseType === "UNKNOWN_TABLE" ||
			(typeof candidate.message === "string" &&
				/service_operations_(?:minutely|hourly)/i.test(candidate.message)))
	)
}

/**
 * `web_events` is a read-path rollup on a `requiredForIngest: false` migration,
 * so a BYO cluster can be perfectly healthy and still not have it — the org just
 * hasn't re-applied schema yet. Same shape as the service-operations detector
 * above, and the same reason: the fallback has to be automatic and per-org,
 * because there is no global moment when every cluster has migrated.
 */
const isMissingWebEvents = (error: unknown): boolean => {
	if (typeof error !== "object" || error === null) return false
	const candidate = error as {
		readonly _tag?: unknown
		readonly clickhouseType?: unknown
		readonly message?: unknown
	}
	return (
		candidate._tag === "@maple/http/errors/WarehouseConfigError" &&
		(candidate.clickhouseType === "UNKNOWN_TABLE" ||
			(typeof candidate.message === "string" && /web_events/i.test(candidate.message)))
	)
}

/**
 * Read a rollup table, degrading to the raw-source query on a cluster that does
 * not have it.
 *
 * **This is error recovery, not a rollout switch.** There is no flag and nothing
 * to set: these rollups ship in `requiredForIngest: false` migrations, which
 * reach a BYO-ClickHouse cluster only when an org admin opens Settings → BYO
 * Backend and clicks Apply schema. Nothing reconciles that — there is no cron,
 * no on-deploy hook, and `upsert` deliberately runs no DDL.
 * `ClickHouseSchemaApplyWorkflow` even skips perf-only migrations in its first
 * pass and retries them best-effort inside a try/catch, so a run can report
 * `succeeded` with the table still absent. So the window where an org lacks one
 * is unbounded, per-org, and invisible from here, and the only correct response
 * is to notice at query time and read the other table. Without this, those orgs
 * get a hard 502 titled "Database is not configured correctly" with no
 * remediation hint, indefinitely.
 *
 * The two definitions in each pair are required to return identical rows — this
 * is a source swap, not a semantics change, enforced for web analytics by
 * `web-analytics-parity.clickhouse.e2e.test.ts` — so the degrade is invisible to
 * the caller and needs no response-shape branching. `Effect.fn` would give this
 * a second span; it is deliberately a plain helper so the fallback annotation
 * lands on the handler's own span.
 */
const makeRollupFallback =
	(detect: (error: unknown) => boolean, warning: string) =>
	<A, P, E, R>(
		rollup: (tenant: TenantContext, payload: P) => Effect.Effect<A, E, R>,
		raw: (tenant: TenantContext, payload: P) => Effect.Effect<A, E, R>,
		tenant: TenantContext,
		payload: P,
	): Effect.Effect<A, E, R> =>
		rollup(tenant, payload).pipe(
			Effect.catch((error) => {
				if (!detect(error)) return Effect.fail(error)
				return Effect.gen(function* () {
					yield* Effect.logWarning(warning).pipe(Effect.annotateLogs({ orgId: tenant.orgId }))
					yield* Effect.annotateCurrentSpan("query.rollup.fallback", true)
					return yield* raw(tenant, payload)
				})
			}),
		)

const withWebEventsFallback = makeRollupFallback(
	isMissingWebEvents,
	"web_events is absent on this cluster; reading raw session_events. Apply ClickHouse schema to restore the fast path.",
)

const withServiceOperationsFallback = makeRollupFallback(
	isMissingServiceOperationsRollup,
	"service_operations rollup is absent on this cluster; reading raw traces. Apply ClickHouse schema to restore the fast path.",
)

/**
 * Detection verdict + the counts behind it. `isHttpApiService` lives in the
 * query package next to the query that feeds it, so the API, the web app, and
 * any future MCP/CLI consumer classify identically.
 */
const toApiProfile = (row: {
	readonly httpServerSpans: unknown
	readonly entrySpans: unknown
	readonly distinctEndpoints: unknown
}) => {
	const profile = {
		httpServerSpans: Number(row.httpServerSpans ?? 0),
		entrySpans: Number(row.entrySpans ?? 0),
		distinctEndpoints: Number(row.distinctEndpoints ?? 0),
	}
	return { ...profile, isHttpApi: CH.isHttpApiService(profile) }
}

/**
 * The per-operation sparkline is minute-grain because the rollup it splices is:
 * every interval must be a whole-minute multiple, or the raw edges and the
 * rollup interiors stop tiling and buckets double-count. Nearest-minute
 * rounding of `window/50` keeps roughly fifty points.
 */
const sparklineBucketSeconds = (payload: {
	readonly startTime: string
	readonly endTime: string
	readonly bucketSeconds?: number | undefined
}): number => {
	const windowSeconds = Math.max(
		0,
		(Date.parse(`${payload.endTime.replace(" ", "T")}Z`) -
			Date.parse(`${payload.startTime.replace(" ", "T")}Z`)) /
			1000,
	)
	return Math.max(1, Math.round((payload.bucketSeconds ?? windowSeconds / 50) / 60)) * 60
}

const groupSparklines = (
	rows: ReadonlyArray<{ readonly spanName: unknown; readonly bucket: unknown; readonly count: unknown }>,
) => {
	const sparklines = new Map<string, Array<{ bucket: string; count: number }>>()
	for (const row of rows) {
		const key = String(row.spanName)
		const points = sparklines.get(key) ?? []
		points.push({ bucket: String(row.bucket), count: Number(row.count ?? 0) })
		sparklines.set(key, points)
	}
	return sparklines
}

const decodeTraceId = Schema.decodeSync(TraceId)
const decodeSpanId = Schema.decodeSync(SpanId)
const decodeServiceName = Schema.decodeUnknownSync(ServiceName)
const decodeSpanName = Schema.decodeUnknownSync(SpanName)
const decodeFingerprintHash = Schema.decodeUnknownSync(FingerprintHash)
const decodeCommitSha = Schema.decodeUnknownSync(CommitSha)

// Warehouse stores span status in Title Case (Ok/Error/Unset). Coerce any
// unexpected/empty value to "Unset" rather than throwing during response build.
const decodeStatusCodeOption = Schema.decodeUnknownOption(StatusCode)
const coerceStatusCode = (value: string): StatusCode =>
	Option.getOrElse(decodeStatusCodeOption(value), () => "Unset" as const)

// Most traces opened without a timestamp are still recent (list rows carry
// `?t=`; it's direct/shared/AI links that don't, and those overwhelmingly
// point at fresh traces). Probing the last 48h first prunes to ~2 daily
// partitions; only older traces fall back to the unbounded every-partition
// probe.
const PROBE_RECENT_WINDOW_MS = 48 * 3_600_000

const toServicePlatformRow = (row: CH.ServicePlatformsOutput) => {
	const k8sCluster = String(row.k8sCluster ?? "")
	const k8sPodName = String(row.k8sPodName ?? "")
	const k8sDeploymentName = String(row.k8sDeploymentName ?? "")
	const cloudPlatform = String(row.cloudPlatform ?? "")
	const cloudProvider = String(row.cloudProvider ?? "")
	const faasName = String(row.faasName ?? "")
	const mapleSdkType = String(row.mapleSdkType ?? "")
	const processRuntimeName = String(row.processRuntimeName ?? "")
	// cluster.name alone does not prove the service runs in Kubernetes.
	const isKubernetes = k8sPodName !== "" || k8sDeploymentName !== ""
	// Host infrastructure takes precedence over SDK self-report.
	const platform: "kubernetes" | "cloudflare" | "lambda" | "web" | "unknown" =
		cloudPlatform === "cloudflare.workers" || cloudProvider === "cloudflare"
			? "cloudflare"
			: faasName !== "" || cloudPlatform === "aws_lambda"
				? "lambda"
				: isKubernetes
					? "kubernetes"
					: mapleSdkType === "client"
						? "web"
						: "unknown"
	return {
		serviceName: decodeServiceName(String(row.serviceName ?? "")),
		platform,
		k8sCluster,
		cloudPlatform,
		cloudProvider,
		faasName,
		mapleSdkType,
		processRuntimeName,
	}
}

const toServiceWorkloadRow = (row: CH.ServiceWorkloadsOutput) => ({
	serviceName: decodeServiceName(String(row.serviceName ?? "")),
	workloadKind: row.workloadKind,
	workloadName: String(row.workloadName ?? ""),
	namespace: String(row.namespace ?? ""),
	clusterName: String(row.clusterName ?? ""),
	podCount: Number(row.podCount) || 0,
	avgCpuLimitUtilization: row.avgCpuLimitUtilization == null ? null : Number(row.avgCpuLimitUtilization),
	avgMemoryLimitUtilization:
		row.avgMemoryLimitUtilization == null ? null : Number(row.avgMemoryLimitUtilization),
})

export const HttpQueryEngineLive = HttpApiBuilder.group(MapleInternalApi, "queryEngine", (handlers) =>
	Effect.gen(function* () {
		const queryEngine = yield* QueryEngineService
		const warehouse = yield* WarehouseQueryService
		const { runQuery, runQueryFirst } = makeQueryRunners({ warehouse, queryEngine })

		const executeRawSql = makeExecuteRawSql<
			ExecutionTenant,
			WarehouseExecutionError | RawSqlValidationError
		>(warehouse)

		return handlers
			.handle("executeBatch", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// Resolve the org's warehouse route + config ONCE for the batch.
					// Without it each item independently races resolveRuntimeConfig
					// and they contend — the same ordering problem the other
					// fan-out routes call warmRoute for.
					yield* warehouse.warmRoute(tenant)

					const results = yield* runQueryEngineBatch({
						requests: payload.requests,
						execute: (request) =>
							queryEngine
								.execute(tenant, request)
								.pipe(Effect.map((response) => response.result)),
					})
					return new QueryEngineExecuteBatchResponse({ results })
				}),
			)
			.handle("spanHierarchy", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const nowMs = yield* Clock.currentTimeMillis
					const rows = yield* queryEngine.cachedDirect(
						tenant,
						"spanHierarchy",
						payload,
						// Wrapped in cachedDirect's effect so the probe only fires on a
						// cache miss. `trace_detail_spans` is partitioned by
						// `toDate(Timestamp)`. Without a time predicate the hierarchy query
						// seeks across every daily partition (~30) — p95 ~8.8s vs ~2.3s when
						// pruned to one. When the caller has no timestamp (direct URL,
						// shared link, AI link), resolve one via a cheap LIMIT-1 probe and
						// derive a ±1h window so the main query can prune. The probe itself
						// tries the recent window first (see PROBE_RECENT_WINDOW_MS).
						Effect.gen(function* () {
							let startTime = payload.startTime
							let endTime = payload.endTime
							if (startTime == null || endTime == null) {
								const probe =
									(yield* runQueryFirst(Queries.spanHierarchyProbeRecent, tenant, {
										traceId: payload.traceId,
										startTime: formatWarehouseDateTime(nowMs - PROBE_RECENT_WINDOW_MS),
									})) ?? (yield* runQueryFirst(Queries.spanHierarchyProbe, tenant, payload))
								if (probe?.timestamp != null) {
									const window = partitionWindowAround(probe.timestamp)
									startTime = window.startTime
									endTime = window.endTime
								}
							}
							return yield* runQuery(Queries.spanHierarchy, tenant, {
								traceId: payload.traceId,
								spanId: payload.spanId,
								startTime,
								endTime,
							})
						}),
						traceCacheTtlSeconds(payload.endTime, nowMs),
					)
					const typedRows = rows.map((row) => ({
						...row,
						traceId: decodeTraceId(row.traceId),
						spanId: decodeSpanId(row.spanId),
						spanName: decodeSpanName(row.spanName),
						serviceName: decodeServiceName(row.serviceName),
						statusCode: coerceStatusCode(row.statusCode),
					}))
					return new SpanHierarchyResponse({ data: typedRows })
				}),
			)
			.handle("spanDetail", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const row = yield* runQueryFirst(Queries.spanDetail, tenant, payload)
					return new SpanDetailResponse({
						data: row
							? {
									...row,
									traceId: decodeTraceId(row.traceId),
									spanId: decodeSpanId(row.spanId),
								}
							: null,
					})
				}),
			)
			.handle("errorsByType", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.errorsByType, tenant, payload)
					return new ErrorsByTypeResponse({
						data: rows.map((row) => ({
							fingerprintHash: decodeFingerprintHash(row.fingerprintHash),
							errorLabel: row.errorLabel,
							sampleMessage: row.sampleMessage,
							count: Number(row.count),
							affectedServicesCount: Number(row.affectedServicesCount),
							firstSeen: String(row.firstSeen),
							lastSeen: String(row.lastSeen),
						})),
					})
				}),
			)
			.handle("errorsTimeseries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.errorsTimeseries, tenant, payload)
					return new ErrorsTimeseriesResponse({
						data: rows.map((row) => ({
							bucket: String(row.bucket),
							count: Number(row.count),
						})),
					})
				}),
			)
			.handle("errorsSummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const row = yield* runQueryFirst(Queries.errorsSummary, tenant, payload)
					return new ErrorsSummaryResponse({
						data: row
							? {
									totalErrors: Number(row.totalErrors),
									totalSpans: Number(row.totalSpans),
									errorRate: Number(row.errorRate),
									affectedServicesCount: Number(row.affectedServicesCount),
									affectedTracesCount: Number(row.affectedTracesCount),
								}
							: null,
					})
				}),
			)
			.handle("errorDetailTraces", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.errorDetailTraces, tenant, payload)
					return new ErrorDetailTracesResponse({
						data: rows.map((row) => ({
							traceId: decodeTraceId(row.traceId),
							startTime: String(row.startTime),
							durationMicros: Number(row.durationMicros),
							spanCount: Number(row.spanCount),
							services: row.services.map((service) => decodeServiceName(service)),
							rootSpanName: row.rootSpanName,
							errorMessage: row.errorMessage,
						})),
					})
				}),
			)
			.handle("errorRateByService", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.errorRateByService, tenant, payload)
					return new ErrorRateByServiceResponse({
						data: rows.map((row) => ({
							serviceName: decodeServiceName(row.serviceName),
							totalLogs: Number(row.totalLogs),
							errorLogs: Number(row.errorLogs),
							errorRate: Number(row.errorRate),
						})),
					})
				}),
			)
			.handle("serviceOverview", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.serviceOverview, tenant, payload)
					return new ServiceOverviewResponse({ data: rows })
				}),
			)
			.handle("serviceHealthSnapshot", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.serviceHealthSnapshot, tenant, payload)
					return new ServiceHealthSnapshotResponse({
						data: rows.map((row) => ({
							serviceName: decodeServiceName(row.serviceName),
							environment: row.environment || "unknown",
							requestCount: row.requestCount,
							errorCount: row.errorCount,
							p95LatencyMs: row.p95LatencyMs,
						})),
					})
				}),
			)
			.handle("serviceHealthBaseline", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.serviceHealthBaseline, tenant, payload)
					return new ServiceHealthBaselineResponse({
						data: rows.map((row) => ({
							serviceName: decodeServiceName(String(row.serviceName ?? "")),
							serviceNamespace: String(row.serviceNamespace ?? ""),
							environment: String(row.environment ?? "unknown"),
							baselineP95LatencyMs: Number(row.baselineP95LatencyMs ?? 0),
							baselineSpanCount: Number(row.baselineSpanCount ?? 0),
						})),
					})
				}),
			)
			.handle("serviceApdex", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.serviceApdex, tenant, payload)
					return new ServiceApdexResponse({
						data: rows.map((row) => ({
							bucket: String(row.bucket),
							totalCount: Number(row.totalCount),
							satisfiedCount: Number(row.satisfiedCount),
							toleratingCount: Number(row.toleratingCount),
							apdexScore: Number(row.apdexScore),
						})),
					})
				}),
			)
			.handle("serviceCloudflareStats", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// Counters (metrics_sum) + percentiles (metrics_gauge) run
					// concurrently, then merge by ServiceName. Routed through the org's
					// configured warehouse exactly like the metric explorer reads these
					// same `cloudflare.*` metrics — no special ingest pin needed.
					yield* warehouse.warmRoute(tenant)
					const [counterRows, latencyRows] = yield* Effect.all(
						[
							runQuery(Queries.cloudflareServiceCounters, tenant, payload),
							runQuery(Queries.cloudflareServiceLatency, tenant, payload),
						],
						{ concurrency: 2 },
					)
					const latencyByService = new Map(latencyRows.map((row) => [row.serviceName, row]))
					const data = counterRows.map((row) => {
						const latency = latencyByService.get(row.serviceName)
						return {
							serviceName: row.serviceName,
							requests: row.requests,
							errorCount: row.errorCount,
							latencyP99Ms: latency?.latencyP99Ms ?? 0,
							cpuP99Ms: latency?.cpuP99Ms ?? 0,
						}
					})
					return new ServiceCloudflareStatsResponse({ data })
				}),
			)
			.handle("servicePlanetScaleStats", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const byBranch = payload.database !== undefined
					// Utilization gauges + the two-level connections rollup run
					// concurrently, then merge by database(+branch). Routed through the
					// org's configured warehouse like the metric explorer reads the same
					// scraped `planetscale_*` metrics.
					yield* warehouse.warmRoute(tenant)
					const [gaugeRows, connectionRows, storageRows] = yield* Effect.all(
						[
							runQuery(Queries.planetscaleServiceGauges, tenant, payload),
							runQuery(Queries.planetscaleServiceConnections, tenant, payload),
							runQuery(Queries.planetscaleServiceStorage, tenant, payload),
						],
						{ concurrency: 3 },
					)
					const keyOf = (row: { database: string; branch?: string }) =>
						byBranch ? `${row.database}\x00${row.branch ?? ""}` : row.database
					const connectionsByKey = new Map(connectionRows.map((row) => [keyOf(row), row]))
					const storageByKey = new Map(storageRows.map((row) => [keyOf(row), row]))
					const seen = new Set<string>()
					type MergedStatsRow = {
						readonly database: string
						readonly branch?: string
						readonly cpuMaxPercent: number
						readonly memMaxPercent: number
						readonly replicaLagMaxSeconds: number
						readonly connectionsAvg: number
						readonly connectionsMax: number
						readonly storageUsedPercent: number
						/** 0 = the volume gauges never reported; the client must not render 0% used. */
						readonly storageSamples: number
					}
					const storageFor = (key: string) => {
						const storage = storageByKey.get(key)
						return {
							storageUsedPercent: storage?.storageUsedPercent ?? 0,
							storageSamples: storage?.storageSamples ?? 0,
						}
					}
					// The storage rollup is per-database or per-branch depending on the
					// request; only the latter carries a branch to forward.
					const branchOf = (
						row:
							| { readonly database: string }
							| { readonly database: string; readonly branch: string },
					): { readonly branch?: string } => ("branch" in row ? { branch: row.branch } : {})
					const data: Array<MergedStatsRow> = gaugeRows.map((row) => {
						const key = keyOf(row)
						seen.add(key)
						const connections = connectionsByKey.get(key)
						return {
							...row,
							connectionsAvg: connections?.connectionsAvg ?? 0,
							connectionsMax: connections?.connectionsMax ?? 0,
							...storageFor(key),
						}
					})
					// Databases with connection samples but no utilization gauges still
					// deserve a row (e.g. filtered scrape sets).
					for (const row of connectionRows) {
						const key = keyOf(row)
						if (seen.has(key)) continue
						seen.add(key)
						data.push({
							...row,
							cpuMaxPercent: 0,
							memMaxPercent: 0,
							replicaLagMaxSeconds: 0,
							...storageFor(key),
						})
					}
					// …and so do volumes reporting with no gauges or connections at all —
					// an idle branch still filling its disk is exactly what to surface.
					for (const row of storageRows) {
						const key = keyOf(row)
						if (seen.has(key)) continue
						seen.add(key)
						data.push({
							database: row.database,
							...branchOf(row),
							cpuMaxPercent: 0,
							memMaxPercent: 0,
							replicaLagMaxSeconds: 0,
							connectionsAvg: 0,
							connectionsMax: 0,
							storageUsedPercent: row.storageUsedPercent,
							storageSamples: row.storageSamples,
						})
					}
					return new ServicePlanetScaleStatsResponse({ data })
				}),
			)
			.handle("planetscaleInfraTimeseries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.planetscaleInfraTimeseries, tenant, payload)
					return new PlanetScaleInfraTimeseriesResponse({ data: rows.map((row) => ({ ...row })) })
				}),
			)
			.handle("cloudflareInfraZones", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// Counters (metrics_sum) + percentiles (metrics_gauge) run
					// concurrently, then merge by ServiceName — same shape as
					// serviceCloudflareStats above.
					const filters = toCloudflareFilters(payload)
					yield* warehouse.warmRoute(tenant)
					const [counterRows, latencyRows] = yield* Effect.all(
						[
							runQuery(Queries.cloudflareInfraZoneCounters, tenant, payload),
							runQuery(Queries.cloudflareInfraZoneLatency, tenant, payload),
						],
						{ concurrency: 2 },
					)
					const latencyByService = new Map(latencyRows.map((row) => [row.serviceName, row]))
					const data = counterRows.map((row) => {
						const latency = latencyByService.get(row.serviceName)
						return {
							serviceName: row.serviceName,
							requests: row.requests,
							errors5xx: row.errors5xx,
							cacheHits: row.cacheHits,
							bytes: row.bytes,
							visits: row.visits,
							ttfbP50Ms: latency?.ttfbP50Ms ?? 0,
							ttfbP95Ms: latency?.ttfbP95Ms ?? 0,
							ttfbP99Ms: latency?.ttfbP99Ms ?? 0,
							originP50Ms: latency?.originP50Ms ?? 0,
							originP95Ms: latency?.originP95Ms ?? 0,
							originP99Ms: latency?.originP99Ms ?? 0,
						}
					})
					return new CloudflareInfraZonesResponse({
						data,
						// The latency columns are zone-wide by construction, so a dimension filter
						// narrows the counters but never the percentiles beside them.
						ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(filters, [
							Integrations.CF_METRIC.requests,
							Integrations.CF_METRIC.bytes,
							Integrations.CF_METRIC.visits,
						]),
					})
				}),
			)
			.handle("cloudflareInfraZoneTimeseries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const filters = toCloudflareFilters(payload)
					const rows = yield* runQuery(Queries.cloudflareInfraZoneTimeseries, tenant, payload)
					return new CloudflareInfraZoneTimeseriesResponse({
						data: rows.map((row) => ({ ...row })),
						ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(filters, [
							Integrations.CF_METRIC.requests,
						]),
					})
				}),
			)
			.handle("cloudflareInfraZoneDetail", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const filters = toCloudflareFilters(payload)
					yield* warehouse.warmRoute(tenant)
					const [statusRows, cacheRows, latencyRows] = yield* Effect.all(
						[
							runQuery(Queries.cloudflareInfraZoneDetailStatus, tenant, payload),
							runQuery(Queries.cloudflareInfraZoneDetailCache, tenant, payload),
							runQuery(Queries.cloudflareInfraZoneDetailLatency, tenant, payload),
						],
						{ concurrency: 3 },
					)
					return new CloudflareInfraZoneDetailResponse({
						statusBuckets: statusRows.map((row) => ({ ...row })),
						cacheBuckets: cacheRows.map((row) => ({ ...row })),
						latencyBuckets: latencyRows.map((row) => ({ ...row })),
						ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(filters, [
							Integrations.CF_METRIC.requests,
						]),
						latencyIgnoredFilters: Integrations.cloudflareIgnoredFiltersFor(filters, [
							Integrations.CF_METRIC.edgeTtfb,
							Integrations.CF_METRIC.originDuration,
						]),
					})
				}),
			)
			.handle("cloudflareInfraZoneSecurity", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const filters = toCloudflareFilters(payload)
					yield* warehouse.warmRoute(tenant)
					const [bucketRows, topRows] = yield* Effect.all(
						[
							runQuery(Queries.cloudflareInfraZoneFirewallTimeseries, tenant, payload),
							runQuery(Queries.cloudflareInfraZoneFirewallTop, tenant, payload),
						],
						{ concurrency: 2 },
					)
					return new CloudflareInfraZoneSecurityResponse({
						buckets: bucketRows.map((row) => ({ ...row })),
						top: topRows.map((row) => ({ ...row })),
						ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(filters, [
							Integrations.CF_METRIC.firewallEvents,
						]),
					})
				}),
			)
			.handle("cloudflareInfraZoneDns", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const filters = toCloudflareFilters(payload)
					yield* warehouse.warmRoute(tenant)
					const [bucketRows, nameRows] = yield* Effect.all(
						[
							runQuery(Queries.cloudflareInfraZoneDnsTimeseries, tenant, payload),
							runQuery(Queries.cloudflareInfraZoneDnsBreakdown, tenant, payload),
						],
						{ concurrency: 2 },
					)
					return new CloudflareInfraZoneDnsResponse({
						buckets: bucketRows.map((row) => ({ ...row })),
						names: nameRows.map((row) => ({ ...row })),
						ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(filters, [
							Integrations.CF_METRIC.dnsQueries,
						]),
					})
				}),
			)
			.handle("cloudflareInfraZoneBreakdown", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const filters = toCloudflareFilters(payload)
					yield* warehouse.warmRoute(tenant)
					const [totalRows, coverageRows, zoneRows] = yield* Effect.all(
						[
							runQuery(Queries.cloudflareInfraZoneBreakdownTotals, tenant, payload),
							runQuery(Queries.cloudflareInfraZoneBreakdownCoverage, tenant, payload),
							runQuery(Queries.cloudflareInfraZoneBreakdownZoneTotal, tenant, payload),
						],
						{ concurrency: 3 },
					)
					const topKeys = totalRows
						.filter((row) => row.key !== Integrations.CLOUDFLARE_BREAKDOWN_OTHER_KEY)
						.slice(0, Integrations.CLOUDFLARE_BREAKDOWN_SERIES_LIMIT)
						.map((row) => row.key)
					const bucketRows: ReadonlyArray<Integrations.CloudflareZoneBreakdownTimeseriesOutput> =
						topKeys.length === 0
							? []
							: yield* runQuery(Queries.cloudflareInfraZoneBreakdownTimeseries, tenant, {
									...payload,
									topKeys,
								})
					const coverage = coverageRows[0]
					const zoneRequests = zoneRows.find((row) => row.serviceName === payload.serviceName)
					// Breakdown metrics are a per-window top-N fold of what Cloudflare returned, so
					// they can only ever undercount the zone. Clamp rather than surface a negative.
					const unattributed = Math.max(
						0,
						(zoneRequests?.requests ?? 0) - (coverage?.attributedRequests ?? 0),
					)
					return new CloudflareInfraZoneBreakdownResponse({
						totals: totalRows.map((row) => ({ ...row })),
						buckets: bucketRows.map((row) => ({ ...row })),
						unattributed,
						coverageStart:
							coverage?.coverageStart != null && coverage.coverageStart !== ""
								? coverage.coverageStart
								: null,
						ignoredFilters: Integrations.cloudflareIgnoredFiltersFor(
							filters,
							Integrations.cloudflareBreakdownMetrics(payload.dimension),
						),
					})
				}),
			)
			.handle("cloudflareInfraZoneFacets", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.cloudflareInfraZoneFacets, tenant, payload)
					const buckets = {
						hosts: [] as Array<{ name: string; count: number }>,
						cacheStatuses: [] as Array<{ name: string; count: number }>,
						statusClasses: [] as Array<{ name: string; count: number }>,
						paths: [] as Array<{ name: string; count: number }>,
						countries: [] as Array<{ name: string; count: number }>,
						methods: [] as Array<{ name: string; count: number }>,
						protocols: [] as Array<{ name: string; count: number }>,
						deviceTypes: [] as Array<{ name: string; count: number }>,
					}
					for (const row of rows) {
						// BYO-ClickHouse returns sum() as a JSON string; compileUnion has no
						// rowSchema hook, so coerce here — same as podFacets.
						const entry = { name: String(row.name), count: Number(row.count) || 0 }
						switch (row.facetType) {
							case "host":
								buckets.hosts.push(entry)
								break
							case "cacheStatus":
								buckets.cacheStatuses.push(entry)
								break
							case "statusClass":
								buckets.statusClasses.push(entry)
								break
							case "path":
								buckets.paths.push(entry)
								break
							case "country":
								buckets.countries.push(entry)
								break
							case "method":
								buckets.methods.push(entry)
								break
							case "protocol":
								buckets.protocols.push(entry)
								break
							case "deviceType":
								buckets.deviceTypes.push(entry)
								break
						}
					}
					return new CloudflareInfraZoneFacetsResponse({ data: buckets })
				}),
			)
			.handle("cloudflareInfraPlatformResources", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* warehouse.warmRoute(tenant)
					const [queueRows, doRows] = yield* Effect.all(
						[
							runQuery(Queries.cloudflareInfraQueueGauges, tenant, payload),
							runQuery(Queries.cloudflareInfraDurableObjects, tenant, payload),
						],
						{ concurrency: 2 },
					)
					return new CloudflareInfraPlatformResourcesResponse({
						queues: queueRows.map((row) => ({ ...row })),
						durableObjects: doRows.map((row) => ({ ...row })),
					})
				}),
			)
			.handle("cloudflareInfraWorkers", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* warehouse.warmRoute(tenant)
					const [counterRows, latencyRows] = yield* Effect.all(
						[
							runQuery(Queries.cloudflareInfraWorkerCounters, tenant, payload),
							runQuery(Queries.cloudflareInfraWorkerLatency, tenant, payload),
						],
						{ concurrency: 2 },
					)
					const latencyByService = new Map(latencyRows.map((row) => [row.serviceName, row]))
					const data = counterRows.map((row) => {
						const latency = latencyByService.get(row.serviceName)
						return {
							serviceName: row.serviceName,
							requests: row.requests,
							errors: row.errors,
							subrequests: row.subrequests,
							cpuP50Ms: latency?.cpuP50Ms ?? 0,
							cpuP99Ms: latency?.cpuP99Ms ?? 0,
							durationP50Ms: latency?.durationP50Ms ?? 0,
							durationP99Ms: latency?.durationP99Ms ?? 0,
						}
					})
					return new CloudflareInfraWorkersResponse({ data })
				}),
			)
			.handle("serviceDetailOverview", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// One Worker invocation for the whole Overview tab: per-org config
					// resolves once (the first sub-query warms the in-isolate memo) and
					// the three queries run concurrently, replacing three separate
					// browser->Worker round-trips. The primary chart keeps its own
					// execute-path cache; releases is uncached (mirrors the standalone
					// handler); environments is edge-cached on a service-scoped key.
					yield* warehouse.warmRoute(tenant)
					const [timeseries, releaseRows, environmentRows, apiProfileRow] = yield* Effect.all(
						[
							queryEngine.execute(tenant, payload.timeseries),
							runQuery(Queries.serviceReleases, tenant, payload),
							runQuery(Queries.serviceEnvironments, tenant, {
								serviceName: payload.serviceName,
								startTime: payload.startTime,
								endTime: payload.endTime,
							}),
							// Rides along so the Endpoints tab trigger is known on first
							// paint of EVERY tab, not just Overview (the header's env
							// switcher subscribes to this same response).
							//
							// Deliberately NOT environment-scoped: whether a service is an
							// HTTP API is a property of the service, not of the env you
							// happen to be looking at, and an unscoped answer keeps the tab
							// from flickering away when you select a low-traffic env.
							//
							// Detection is a nicety; the chart is the page. A probe failure
							// degrades to "not an API" rather than failing the bundle.
							runQueryFirst(Queries.serviceApiProfile, tenant, {
								serviceName: payload.serviceName,
								startTime: payload.startTime,
								endTime: payload.endTime,
							}).pipe(Effect.orElseSucceed(() => null)),
						],
						{ concurrency: 4 },
					)
					return new ServiceDetailOverviewResponse({
						timeseries,
						releases: releaseRows.map((row) => ({
							bucket: String(row.bucket),
							commitSha: decodeCommitSha(row.commitSha),
							count: Number(row.count),
							errorCount: Number(row.errorCount),
						})),
						environments: environmentRows
							.map((row) => String(row.environment ?? ""))
							.filter((env) => env !== ""),
						...(apiProfileRow ? { apiProfile: toApiProfile(apiProfileRow) } : {}),
					})
				}),
			)
			.handle("serviceDependenciesBundle", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// Dependencies tab in one Worker invocation: the three service-map
					// edge queries run concurrently and share a single config
					// resolution, replacing three independent round-trips.
					yield* warehouse.warmRoute(tenant)
					const [dependencyRows, dbEdgeRows, externalEdgeRows] = yield* Effect.all(
						[
							runQuery(Queries.serviceDependenciesForService, tenant, payload),
							runQuery(Queries.serviceDbEdgesForService, tenant, payload),
							runQuery(Queries.serviceExternalEdges, tenant, payload),
						],
						{ concurrency: 3 },
					)
					return new ServiceDependenciesBundleResponse({
						dependencies: dependencyRows.map((row) => ({ ...row })),
						dbEdges: dbEdgeRows.map((row) => ({ ...row })),
						externalEdges: externalEdgeRows.map((row) => ({ ...row })),
					})
				}),
			)
			.handle("serviceMapBundle", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// Resolve warehouse routing once before the fan-out.
					yield* warehouse.warmRoute(tenant)
					const [dependencyRows, overviewRows, dbEdgeRows, platformRows] = yield* Effect.all(
						[
							runQuery(Queries.serviceDependencies, tenant, payload),
							runQuery(Queries.serviceOverview, tenant, payload),
							runQuery(Queries.serviceDbEdges, tenant, payload),
							runQuery(Queries.servicePlatforms, tenant, payload),
						],
						{ concurrency: 4 },
					)

					const services = new Set<string>()
					for (const row of dependencyRows) {
						services.add(String(row.sourceService ?? ""))
						services.add(String(row.targetService ?? ""))
					}
					for (const row of overviewRows) services.add(String(row.serviceName ?? ""))
					services.delete("")

					const workloadRows =
						services.size === 0
							? []
							: yield* runQuery(Queries.serviceWorkloads, tenant, {
									startTime: payload.startTime,
									endTime: payload.endTime,
									services: Array.from(services)
										.sort()
										.map((name) => decodeServiceName(name)),
								})

					return new ServiceMapBundleResponse({
						dependencies: dependencyRows.map((row) => ({ ...row })),
						dbEdges: dbEdgeRows.map((row) => ({ ...row })),
						overview: overviewRows.map((row) => ({ ...row })),
						platforms: platformRows.map(toServicePlatformRow),
						workloads: workloadRows.map(toServiceWorkloadRow),
					})
				}),
			)
			.handle("serviceDbQuerySummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context

					yield* warehouse.warmRoute(tenant)
					const [summary, timeseriesRows, topQueryRows] = yield* Effect.all(
						[
							runQueryFirst(Queries.serviceDbQuerySummary, tenant, payload),
							runQuery(Queries.serviceDbQueryTimeseries, tenant, payload),
							runQuery(Queries.serviceDbTopQueries, tenant, payload),
						],
						{ concurrency: 3 },
					)

					const toNumber = (value: unknown) => Number(value ?? 0)
					return new ServiceDbQuerySummaryResponse({
						summary:
							summary && toNumber(summary.queryCount) > 0
								? {
										queryCount: toNumber(summary.queryCount),
										estimatedQueryCount: toNumber(summary.estimatedQueryCount),
										errorCount: toNumber(summary.errorCount),
										estimatedErrorCount: toNumber(summary.estimatedErrorCount),
										errorRate: toNumber(summary.errorRate),
										avgDurationMs: toNumber(summary.avgDurationMs),
										p50DurationMs: toNumber(summary.p50DurationMs),
										p95DurationMs: toNumber(summary.p95DurationMs),
										activeServiceCount: toNumber(summary.activeServiceCount),
									}
								: null,
						timeseries: timeseriesRows.map((row) => ({
							bucket: String(row.bucket),
							queryCount: toNumber(row.queryCount),
							estimatedQueryCount: toNumber(row.estimatedQueryCount),
							errorCount: toNumber(row.errorCount),
							errorRate: toNumber(row.errorRate),
							avgDurationMs: toNumber(row.avgDurationMs),
							p50DurationMs: toNumber(row.p50DurationMs),
							p95DurationMs: toNumber(row.p95DurationMs),
						})),
						topQueries: topQueryRows.map((row) => ({
							queryKey: String(row.queryKey),
							queryLabel: String(row.queryLabel),
							sampleStatement: String(row.sampleStatement),
							sampleService: String(row.sampleService),
							serviceCount: toNumber(row.serviceCount),
							queryCount: toNumber(row.queryCount),
							estimatedQueryCount: toNumber(row.estimatedQueryCount),
							errorCount: toNumber(row.errorCount),
							errorRate: toNumber(row.errorRate),
							avgDurationMs: toNumber(row.avgDurationMs),
							p50DurationMs: toNumber(row.p50DurationMs),
							p95DurationMs: toNumber(row.p95DurationMs),
							lastSeen: String(row.lastSeen),
						})),
					})
				}),
			)
			.handle("serviceWorkloads", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					if (payload.services.length === 0) {
						return new ServiceWorkloadsResponse({ data: [] })
					}
					const rows = yield* runQuery(Queries.serviceWorkloads, tenant, payload)
					return new ServiceWorkloadsResponse({ data: rows.map(toServiceWorkloadRow) })
				}),
			)
			.handle("serviceUsage", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.serviceUsage, tenant, payload)
					return new ServiceUsageResponse({ data: rows })
				}),
			)
			.handle("serviceOperations", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const toNumber = (value: unknown) => Number(value ?? 0)
					const data = yield* queryEngine.cachedDirect(
						tenant,
						"serviceOperations",
						payload,
						Effect.gen(function* () {
							// Both reads try `service_operations_minutely`/`_hourly` and
							// degrade per-org on UNKNOWN_TABLE. The timeseries read repeats
							// the probe rather than inheriting the summary's verdict: one
							// extra failed query on a cluster that never applied migration
							// 0008 is cheaper than the mutable flag this replaced.
							const summaryRows = yield* mapExecError(
								withServiceOperationsFallback(
									(t, pl) => runQuery(Queries.serviceOperationsSummary, t, pl),
									(t, pl) => runQuery(Queries.serviceOperationsSummaryRaw, t, pl),
									tenant,
									payload,
								),
								"serviceOperations query failed",
							)
							if (summaryRows.length === 0) {
								return []
							}

							const spanNames = summaryRows.map((row) => String(row.spanName))
							const timeseriesInput = {
								...payload,
								spanNames,
								bucketSeconds: sparklineBucketSeconds(payload),
							}
							const timeseriesRows = yield* mapExecError(
								withServiceOperationsFallback(
									(t, pl) => runQuery(Queries.serviceOperationsTimeseries, t, pl),
									(t, pl) => runQuery(Queries.serviceOperationsTimeseriesRaw, t, pl),
									tenant,
									timeseriesInput,
								),
								"serviceOperationsTimeseries query failed",
							)

							const sparklines = groupSparklines(timeseriesRows)

							return summaryRows.map((row) => ({
								spanName: String(row.spanName),
								spanCount: toNumber(row.spanCount),
								estimatedSpanCount: toNumber(row.estimatedSpanCount),
								errorCount: toNumber(row.errorCount),
								estimatedErrorCount: toNumber(row.estimatedErrorCount),
								errorRate: toNumber(row.errorRate),
								avgDurationMs: toNumber(row.avgDurationMs),
								p50DurationMs: toNumber(row.p50DurationMs),
								p95DurationMs: toNumber(row.p95DurationMs),
								sparkline: sparklines.get(String(row.spanName)) ?? [],
							}))
						}),
						30,
					)
					return new ServiceOperationsResponse({ data })
				}),
			)
			.handle("serviceEndpoints", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const toNumber = (value: unknown) => Number(value ?? 0)
					const data = yield* queryEngine.cachedDirect(
						tenant,
						"serviceEndpoints",
						payload,
						Effect.gen(function* () {
							// Same rollup-or-raw shape as `serviceOperations`: both reads
							// try `service_operations_minutely`/`_hourly` and degrade per-org
							// on UNKNOWN_TABLE, and the timeseries read repeats the probe
							// rather than inheriting the summary's verdict.
							const summaryRows = yield* mapExecError(
								withServiceOperationsFallback(
									(t, pl) => runQuery(Queries.serviceEndpointsSummary, t, pl),
									(t, pl) => runQuery(Queries.serviceEndpointsSummaryRaw, t, pl),
									tenant,
									payload,
								),
								"serviceEndpoints query failed",
							)
							if (summaryRows.length === 0) {
								return []
							}

							// Sparklines reuse the operations timeseries verbatim — it keys
							// on the display span name, which is exactly what the endpoint
							// summary returns alongside the split method/route.
							const spanNames = summaryRows.map((row) => String(row.spanName))
							const timeseriesInput = {
								...payload,
								spanNames,
								bucketSeconds: sparklineBucketSeconds(payload),
							}
							const timeseriesRows = yield* mapExecError(
								withServiceOperationsFallback(
									(t, pl) => runQuery(Queries.serviceOperationsTimeseries, t, pl),
									(t, pl) => runQuery(Queries.serviceOperationsTimeseriesRaw, t, pl),
									tenant,
									timeseriesInput,
								),
								"serviceEndpointsTimeseries query failed",
							)
							const sparklines = groupSparklines(timeseriesRows)

							return summaryRows.map((row) => ({
								spanName: String(row.spanName),
								method: String(row.method ?? ""),
								route: String(row.route ?? ""),
								spanCount: toNumber(row.spanCount),
								estimatedSpanCount: toNumber(row.estimatedSpanCount),
								errorCount: toNumber(row.errorCount),
								estimatedErrorCount: toNumber(row.estimatedErrorCount),
								errorRate: toNumber(row.errorRate),
								avgDurationMs: toNumber(row.avgDurationMs),
								p50DurationMs: toNumber(row.p50DurationMs),
								p95DurationMs: toNumber(row.p95DurationMs),
								p99DurationMs: toNumber(row.p99DurationMs),
								sparkline: sparklines.get(String(row.spanName)) ?? [],
							}))
						}),
						30,
					)
					return new ServiceEndpointsResponse({ data })
				}),
			)
			.handle("endpointStatusBreakdown", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.endpointStatusBreakdown, tenant, payload)
					return new EndpointStatusBreakdownResponse({
						data: rows.map((row) => ({
							statusClass: String(row.statusClass),
							spanCount: Number(row.spanCount ?? 0),
							estimatedSpanCount: Number(row.estimatedSpanCount ?? 0),
						})),
					})
				}),
			)
			.handle("listLogs", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.listLogs, tenant, payload)
					return new ListLogsResponse({ data: rows })
				}),
			)
			.handle("getLog", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.getLog, tenant, payload)
					return new GetLogResponse({ data: rows })
				}),
			)
			.handle("listMetrics", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.listMetrics, tenant, payload)
					return new ListMetricsResponse({ data: rows })
				}),
			)
			.handle("metricsSummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.metricsSummary, tenant, payload)
					return new MetricsSummaryResponse({
						data: rows.map((row) => ({
							metricType: row.metricType,
							metricCount: Number(row.metricCount),
							dataPointCount: Number(row.dataPointCount),
						})),
					})
				}),
			)
			.handle("listHosts", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.listHosts, tenant, payload)
					return new ListHostsResponse({
						data: rows.map((row) => ({
							hostName: row.hostName,
							osType: row.osType,
							hostArch: row.hostArch,
							cloudProvider: row.cloudProvider,
							lastSeen: String(row.lastSeen),
							cpuPct: Number(row.cpuPct) || 0,
							memoryPct: Number(row.memoryPct) || 0,
							diskPct: Number(row.diskPct) || 0,
							load15: Number(row.load15) || 0,
						})),
					})
				}),
			)
			.handle("hostDetailSummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const row = yield* runQueryFirst(Queries.hostDetailSummary, tenant, payload)
					return new HostDetailSummaryResponse({
						data: row
							? {
									hostName: row.hostName,
									osType: row.osType,
									hostArch: row.hostArch,
									cloudProvider: row.cloudProvider,
									cloudRegion: row.cloudRegion,
									firstSeen: String(row.firstSeen),
									lastSeen: String(row.lastSeen),
									cpuPct: Number(row.cpuPct) || 0,
									memoryPct: Number(row.memoryPct) || 0,
									diskPct: Number(row.diskPct) || 0,
									load15: Number(row.load15) || 0,
								}
							: null,
					})
				}),
			)
			.handle("fleetUtilizationTimeseries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.fleetUtilizationTimeseries, tenant, payload)
					return new FleetUtilizationTimeseriesResponse({
						data: rows.map((row) => ({
							bucket: String(row.bucket),
							avgCpu: Number(row.avgCpu) || 0,
							avgMemory: Number(row.avgMemory) || 0,
							activeHosts: Number(row.activeHosts) || 0,
						})),
					})
				}),
			)
			.handle("hostInfraTimeseries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const bucketSeconds = payload.bucketSeconds ?? 60

					const spec = hostMetricSpec(payload.metric)

					if (spec.isNetwork) {
						const rows = yield* runQuery(Queries.hostInfraNetworkTimeseries, tenant, payload)
						return new HostInfraTimeseriesResponse({
							data: rows.map((row) => ({
								bucket: String(row.bucket),
								attributeValue: String(row.attributeValue ?? ""),
								value: Number(row.sumValue) || 0,
							})),
							groupByAttributeKey: spec.groupByAttributeKey,
							unit: spec.unit,
						})
					}

					const rows = yield* runQuery(Queries.hostInfraGaugeTimeseries, tenant, payload)
					return new HostInfraTimeseriesResponse({
						data: rows.map((row) => ({
							bucket: String(row.bucket),
							attributeValue: String(row.attributeValue ?? ""),
							value: Number(row.avgValue) || 0,
						})),
						groupByAttributeKey: spec.groupByAttributeKey,
						unit: spec.unit,
					})
				}),
			)
			.handle("listPods", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* warehouse.warmRoute(tenant)
					const [rows, countRow] = yield* Effect.all(
						[
							runQuery(Queries.listPods, tenant, payload),
							runQueryFirst(Queries.listPodsCount, tenant, payload),
						],
						{ concurrency: 2 },
					)
					return new ListPodsResponse({
						data: rows.map((row) => ({
							podName: row.podName,
							namespace: row.namespace,
							nodeName: row.nodeName,
							clusterName: row.clusterName,
							environment: row.environment,
							deploymentName: row.deploymentName,
							statefulsetName: row.statefulsetName,
							daemonsetName: row.daemonsetName,
							jobName: row.jobName,
							qosClass: row.qosClass,
							podUid: row.podUid,
							computeType: row.computeType,
							lastSeen: String(row.lastSeen),
							cpuUsage: Number(row.cpuUsage) || 0,
							cpuLimitPct: Number(row.cpuLimitPct) || 0,
							memoryLimitPct: Number(row.memoryLimitPct) || 0,
							cpuRequestPct: Number(row.cpuRequestPct) || 0,
							memoryRequestPct: Number(row.memoryRequestPct) || 0,
							cpuUsagePeak: Number(row.cpuUsagePeak) || 0,
							cpuLimitPctPeak: Number(row.cpuLimitPctPeak) || 0,
							memoryLimitPctPeak: Number(row.memoryLimitPctPeak) || 0,
							saturation: Number(row.saturation) || 0,
						})),
						// The denominator has to match the predicate the list ran, or a scoped
						// view reads "Top 17 of 541". The scope counts are already computed.
						totalCount:
							Number(
								payload.scope === "saturated"
									? countRow?.saturatedPods
									: payload.scope === "elevated"
										? countRow?.elevatedPods
										: payload.scope === "unbounded"
											? countRow?.unboundedPods
											: payload.scope === "stale"
												? countRow?.stalePods
												: countRow?.totalPods,
							) ||
							// A failed count must not render as "0 of 0" under a list with rows.
							rows.length,
					})
				}),
			)
			.handle("podsSummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const row = yield* runQueryFirst(Queries.podsSummary, tenant, payload)
					return new PodsSummaryResponse({
						totalPods: Number(row?.totalPods) || 0,
						saturatedPods: Number(row?.saturatedPods) || 0,
						elevatedPods: Number(row?.elevatedPods) || 0,
						unboundedPods: Number(row?.unboundedPods) || 0,
						stalePods: Number(row?.stalePods) || 0,
					})
				}),
			)
			.handle("podDetailSummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const row = yield* runQueryFirst(Queries.podDetailSummary, tenant, payload)
					return new PodDetailSummaryResponse({
						data: row
							? {
									podName: row.podName,
									namespace: row.namespace,
									nodeName: row.nodeName,
									deploymentName: row.deploymentName,
									statefulsetName: row.statefulsetName,
									daemonsetName: row.daemonsetName,
									qosClass: row.qosClass,
									podUid: row.podUid,
									computeType: row.computeType,
									podStartTime: row.podStartTime,
									firstSeen: String(row.firstSeen),
									lastSeen: String(row.lastSeen),
									cpuUsage: Number(row.cpuUsage) || 0,
									cpuLimitPct: Number(row.cpuLimitPct) || 0,
									memoryLimitPct: Number(row.memoryLimitPct) || 0,
									cpuRequestPct: Number(row.cpuRequestPct) || 0,
									memoryRequestPct: Number(row.memoryRequestPct) || 0,
								}
							: null,
					})
				}),
			)
			.handle("podInfraTimeseries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const spec = podMetricSpec(payload.metric)
					const rows = yield* runQuery(Queries.podInfraTimeseries, tenant, payload)
					return new PodInfraTimeseriesResponse({
						data: rows.map((row) => ({
							bucket: String(row.bucket),
							attributeValue: String(row.attributeValue ?? ""),
							value: Number(row.avgValue) || 0,
						})),
						unit: spec.unit,
					})
				}),
			)
			.handle("listNodes", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.listNodes, tenant, payload)
					return new ListNodesResponse({
						data: rows.map((row) => ({
							nodeName: row.nodeName,
							nodeUid: row.nodeUid,
							clusterName: row.clusterName,
							environment: row.environment,
							kubeletVersion: row.kubeletVersion,
							lastSeen: String(row.lastSeen),
							cpuUsage: Number(row.cpuUsage) || 0,
							uptime: Number(row.uptime) || 0,
						})),
					})
				}),
			)
			.handle("nodeDetailSummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const row = yield* runQueryFirst(Queries.nodeDetailSummary, tenant, payload)
					return new NodeDetailSummaryResponse({
						data: row
							? {
									nodeName: row.nodeName,
									nodeUid: row.nodeUid,
									kubeletVersion: row.kubeletVersion,
									containerRuntime: row.containerRuntime,
									firstSeen: String(row.firstSeen),
									lastSeen: String(row.lastSeen),
									cpuUsage: Number(row.cpuUsage) || 0,
									uptime: Number(row.uptime) || 0,
								}
							: null,
					})
				}),
			)
			.handle("nodeInfraTimeseries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const spec = nodeMetricSpec(payload.metric)
					const rows = yield* runQuery(Queries.nodeInfraTimeseries, tenant, payload)
					return new NodeInfraTimeseriesResponse({
						data: rows.map((row) => ({
							bucket: String(row.bucket),
							attributeValue: String(row.attributeValue ?? ""),
							value: Number(row.avgValue) || 0,
						})),
						unit: spec.unit,
					})
				}),
			)
			.handle("listWorkloads", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.listWorkloads, tenant, payload)
					return new ListWorkloadsResponse({
						data: rows.map((row) => ({
							workloadName: row.workloadName,
							namespace: row.namespace,
							clusterName: row.clusterName,
							environment: row.environment,
							podCount: Number(row.podCount) || 0,
							lastSeen: String(row.lastSeen),
							avgCpuLimitPct: Number(row.avgCpuLimitPct) || 0,
							avgMemoryLimitPct: Number(row.avgMemoryLimitPct) || 0,
							avgCpuUsage: Number(row.avgCpuUsage) || 0,
						})),
					})
				}),
			)
			.handle("workloadDetailSummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const row = yield* runQueryFirst(Queries.workloadDetailSummary, tenant, payload)
					return new WorkloadDetailSummaryResponse({
						data: row
							? {
									workloadName: row.workloadName,
									kind: payload.kind,
									namespace: row.namespace,
									podCount: Number(row.podCount) || 0,
									firstSeen: String(row.firstSeen),
									lastSeen: String(row.lastSeen),
									avgCpuLimitPct: Number(row.avgCpuLimitPct) || 0,
									avgMemoryLimitPct: Number(row.avgMemoryLimitPct) || 0,
									avgCpuUsage: Number(row.avgCpuUsage) || 0,
								}
							: null,
					})
				}),
			)
			.handle("workloadInfraTimeseries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const spec = workloadMetricSpec(payload.metric)
					const rows = yield* runQuery(Queries.workloadInfraTimeseries, tenant, payload)
					return new WorkloadInfraTimeseriesResponse({
						data: rows.map((row) => ({
							bucket: String(row.bucket),
							attributeValue: String(row.attributeValue ?? ""),
							value: Number(row.avgValue) || 0,
						})),
						unit: spec.unit,
					})
				}),
			)
			.handle("podFacets", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.podFacets, tenant, payload)
					const buckets = {
						pods: [] as Array<{ name: string; count: number }>,
						namespaces: [] as Array<{ name: string; count: number }>,
						nodes: [] as Array<{ name: string; count: number }>,
						clusters: [] as Array<{ name: string; count: number }>,
						deployments: [] as Array<{ name: string; count: number }>,
						statefulsets: [] as Array<{ name: string; count: number }>,
						daemonsets: [] as Array<{ name: string; count: number }>,
						jobs: [] as Array<{ name: string; count: number }>,
						environments: [] as Array<{ name: string; count: number }>,
						computeTypes: [] as Array<{ name: string; count: number }>,
					}
					for (const row of rows) {
						const entry = { name: String(row.name), count: Number(row.count) || 0 }
						switch (row.facetType) {
							case "pod":
								buckets.pods.push(entry)
								break
							case "namespace":
								buckets.namespaces.push(entry)
								break
							case "node":
								buckets.nodes.push(entry)
								break
							case "cluster":
								buckets.clusters.push(entry)
								break
							case "deployment":
								buckets.deployments.push(entry)
								break
							case "statefulset":
								buckets.statefulsets.push(entry)
								break
							case "daemonset":
								buckets.daemonsets.push(entry)
								break
							case "job":
								buckets.jobs.push(entry)
								break
							case "environment":
								buckets.environments.push(entry)
								break
							case "computeType":
								buckets.computeTypes.push(entry)
								break
						}
					}
					return new PodFacetsResponse({ data: buckets })
				}),
			)
			.handle("nodeFacets", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.nodeFacets, tenant, payload)
					const buckets = {
						nodes: [] as Array<{ name: string; count: number }>,
						clusters: [] as Array<{ name: string; count: number }>,
						environments: [] as Array<{ name: string; count: number }>,
					}
					for (const row of rows) {
						const entry = { name: String(row.name), count: Number(row.count) || 0 }
						switch (row.facetType) {
							case "node":
								buckets.nodes.push(entry)
								break
							case "cluster":
								buckets.clusters.push(entry)
								break
							case "environment":
								buckets.environments.push(entry)
								break
						}
					}
					return new NodeFacetsResponse({ data: buckets })
				}),
			)
			.handle("workloadFacets", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* runQuery(Queries.workloadFacets, tenant, payload)
					const buckets = {
						workloads: [] as Array<{ name: string; count: number }>,
						namespaces: [] as Array<{ name: string; count: number }>,
						clusters: [] as Array<{ name: string; count: number }>,
						environments: [] as Array<{ name: string; count: number }>,
						computeTypes: [] as Array<{ name: string; count: number }>,
					}
					for (const row of rows) {
						const entry = { name: String(row.name), count: Number(row.count) || 0 }
						switch (row.facetType) {
							case "workload":
								buckets.workloads.push(entry)
								break
							case "namespace":
								buckets.namespaces.push(entry)
								break
							case "cluster":
								buckets.clusters.push(entry)
								break
							case "environment":
								buckets.environments.push(entry)
								break
							case "computeType":
								buckets.computeTypes.push(entry)
								break
						}
					}
					return new WorkloadFacetsResponse({ data: buckets })
				}),
			)
			.handle("webAnalyticsSummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const row = yield* withWebEventsFallback(
						(t, pl) => runQueryFirst(Queries.webAnalyticsSummary, t, pl),
						(t, pl) => runQueryFirst(Queries.webAnalyticsSummaryRaw, t, pl),
						tenant,
						payload,
					)
					// A window with no sessions returns no rows at all, not a row of
					// zeroes — the page needs the zeroes to render its empty state.
					return new WebAnalyticsSummaryResponse({
						data: {
							visitors: Number(row?.visitors) || 0,
							sessions: Number(row?.sessions) || 0,
							newSessions: Number(row?.newSessions) || 0,
							bouncedSessions: Number(row?.bouncedSessions) || 0,
							identifiedSessions: Number(row?.identifiedSessions) || 0,
							avgDurationMs: Number(row?.avgDurationMs) || 0,
						},
					})
				}),
			)
			.handle("webAnalyticsTimeseries", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* withWebEventsFallback(
						(t, pl) => runQuery(Queries.webAnalyticsTimeseries, t, pl),
						(t, pl) => runQuery(Queries.webAnalyticsTimeseriesRaw, t, pl),
						tenant,
						payload,
					)
					return new WebAnalyticsTimeseriesResponse({
						data: rows.map((row) => ({
							bucket: String(row.bucket),
							visitors: Number(row.visitors) || 0,
							sessions: Number(row.sessions) || 0,
							newSessions: Number(row.newSessions) || 0,
							bouncedSessions: Number(row.bouncedSessions) || 0,
							identifiedSessions: Number(row.identifiedSessions) || 0,
							avgDurationMs: Number(row.avgDurationMs) || 0,
						})),
					})
				}),
			)
			.handle("webAnalyticsPageviews", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* withWebEventsFallback(
						(t, pl) => runQuery(Queries.webAnalyticsPageviews, t, pl),
						(t, pl) => runQuery(Queries.webAnalyticsPageviewsRaw, t, pl),
						tenant,
						payload,
					)
					return new WebAnalyticsPageviewsResponse({
						data: rows.map((row) => ({
							bucket: String(row.bucket),
							pageViews: Number(row.pageViews) || 0,
							sessions: Number(row.sessions) || 0,
						})),
					})
				}),
			)
			.handle("webAnalyticsPages", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* withWebEventsFallback(
						(t, pl) => runQuery(Queries.webAnalyticsPages, t, pl),
						(t, pl) => runQuery(Queries.webAnalyticsPagesRaw, t, pl),
						tenant,
						payload,
					)
					return new WebAnalyticsPagesResponse({
						data: rows.map((row) => ({
							host: String(row.host),
							pagePath: String(row.pagePath),
							pageViews: Number(row.pageViews) || 0,
							sessions: Number(row.sessions) || 0,
						})),
					})
				}),
			)
			.handle("webAnalyticsBreakdowns", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const rows = yield* withWebEventsFallback(
						(t, pl) => runQuery(Queries.webAnalyticsBreakdowns, t, pl),
						(t, pl) => runQuery(Queries.webAnalyticsBreakdownsRaw, t, pl),
						tenant,
						payload,
					)
					const buckets = {
						referrerHosts: [] as Array<{ name: string; count: number }>,
						countries: [] as Array<{ name: string; count: number }>,
						deviceTypes: [] as Array<{ name: string; count: number }>,
						browsers: [] as Array<{ name: string; count: number }>,
						operatingSystems: [] as Array<{ name: string; count: number }>,
						languages: [] as Array<{ name: string; count: number }>,
						utmSources: [] as Array<{ name: string; count: number }>,
						utmMediums: [] as Array<{ name: string; count: number }>,
						utmCampaigns: [] as Array<{ name: string; count: number }>,
						entryPaths: [] as Array<{ name: string; count: number }>,
						exitPaths: [] as Array<{ name: string; count: number }>,
						hosts: [] as Array<{ name: string; count: number }>,
					}
					// facetType → response key. A table rather than a twelve-arm switch:
					// the mapping is the whole content of this step, and the keys have to
					// stay in step with WebAnalyticsFacetKey in the query builder.
					const bucketOf: Record<string, keyof typeof buckets> = {
						referrerHost: "referrerHosts",
						country: "countries",
						deviceType: "deviceTypes",
						browserName: "browsers",
						osName: "operatingSystems",
						language: "languages",
						utmSource: "utmSources",
						utmMedium: "utmMediums",
						utmCampaign: "utmCampaigns",
						entryPath: "entryPaths",
						exitPath: "exitPaths",
						host: "hosts",
					}
					for (const row of rows) {
						const key = bucketOf[row.facetType]
						if (key) buckets[key].push({ name: String(row.name), count: Number(row.count) || 0 })
					}
					return new WebAnalyticsBreakdownsResponse({ data: buckets })
				}),
			)
			.handle("executeRawSql", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context

					const autoBucketSeconds = computeAutoBucketSeconds(payload.startTime, payload.endTime)
					const granularitySeconds = payload.granularitySeconds ?? autoBucketSeconds

					const result = yield* mapExecError(
						executeRawSql(tenant, {
							sql: payload.sql,
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
							granularitySeconds,
							workload: "interactive",
							context: "rawSql",
						}),
						"rawSql query failed",
					)

					return new RawSqlExecuteResponse({
						data: result.rows,
						meta: {
							rowCount: result.rowCount,
							columns: result.columns,
							granularitySeconds: result.granularitySeconds,
						},
					})
				}),
			)
	}),
)

/**
 * Auto-bucket for raw-SQL `$__interval_s` when the caller didn't supply
 * `granularitySeconds`.
 *
 * Was a private ladder duplicating `computeBucketSeconds`, then a private copy of
 * the string-parse-and-fall-back rule. Both now live in `BUCKET_POLICIES.rawSql`,
 * whose 300s floor is load-bearing: a sub-5-minute `$__interval_s` produces
 * exactly the scan the granularity was chosen to avoid.
 */
function computeAutoBucketSeconds(startTime: string, endTime: string): number {
	return computeBucketSecondsForRange(startTime, endTime, "rawSql")
}
