import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	ExecuteQueryBuilderResponse,
	MapleApi,
	QueryEngineExecutionError,
	QueryEngineValidationError,
	RawSqlExecuteResponse,
	SpanHierarchyResponse,
	SpanDetailResponse,
	ErrorsByTypeResponse,
	ErrorsTimeseriesResponse,
	ErrorsSummaryResponse,
	ErrorDetailTracesResponse,
	ErrorRateByServiceResponse,
	ServiceOverviewResponse,
	ServiceHealthBaselineResponse,
	ServiceApdexResponse,
	ServiceDependenciesResponse,
	ServiceDbEdgesResponse,
	ServiceDbQuerySummaryResponse,
	ServiceExternalEdgesResponse,
	ServiceDetailOverviewResponse,
	ServiceDependenciesBundleResponse,
	ServicePlatformsResponse,
	ServiceWorkloadsResponse,
	ServiceUsageResponse,
	ListLogsResponse,
	GetLogResponse,
	ListMetricsResponse,
	MetricsSummaryResponse,
	ListHostsResponse,
	HostDetailSummaryResponse,
	HostInfraTimeseriesResponse,
	FleetUtilizationTimeseriesResponse,
	ListPodsResponse,
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
	CommitSha,
	FingerprintHash,
	ServiceName,
	SpanName,
	StatusCode,
	TraceId,
	SpanId,
} from "@maple/domain/http"
import { Effect, Match, Option, Schema } from "effect"
import { QueryEngineService } from "../services/QueryEngineService"
import { RawSqlChartService } from "@maple/query-engine/runtime"
import { WarehouseQueryService } from "../lib/WarehouseQueryService"
import { CH, QueryEngineExecuteRequest } from "@maple/query-engine"
import { LOGS_BODY_SEARCH_SETTINGS } from "@maple/query-engine/profiles"
import { buildBreakdownQuerySpec, buildTimeseriesQuerySpec } from "@maple/query-engine/query-builder"

// `warehouse.sqlQuery` fails with the warehouse error union (distinct tagged
// classes per failure mode). This identity combinator threads that typed error
// channel through unchanged so HTTP status mapping stays accurate — every
// endpoint declares the full set via `warehouseHttpErrors`.
const mapExecError = <A, E, R>(effect: Effect.Effect<A, E, R>, _context: string): Effect.Effect<A, E, R> =>
	effect

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

// Build a ±1h partition-pruning window around a ClickHouse datetime string
// (`YYYY-MM-DD HH:mm:ss[.ffffff]`). Sub-second precision is irrelevant for the
// window bounds, so the seconds-level prefix is parsed as UTC.
const partitionWindowAround = (timestamp: string): { startTime: string; endTime: string } => {
	const ms = Date.parse(`${timestamp.slice(0, 19).replace(" ", "T")}Z`)
	const fmt = (epoch: number) => new Date(epoch).toISOString().replace("T", " ").slice(0, 19)
	return { startTime: fmt(ms - 3_600_000), endTime: fmt(ms + 3_600_000) }
}

export const HttpQueryEngineLive = HttpApiBuilder.group(MapleApi, "queryEngine", (handlers) =>
	Effect.gen(function* () {
		const queryEngine = yield* QueryEngineService
		const warehouse = yield* WarehouseQueryService
		const rawSqlChart = yield* RawSqlChartService

		return handlers
			.handle("execute", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* queryEngine.execute(tenant, payload)
				}),
			)
			.handle("spanHierarchy", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
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
						// derive a ±1h window so the main query can prune.
						Effect.gen(function* () {
							let startTime = payload.startTime
							let endTime = payload.endTime
							if (startTime == null || endTime == null) {
								const probe = yield* mapExecError(
									warehouse
										.compiledQueryFirst(
											tenant,
											CH.compile(CH.traceTimeProbeQuery({ traceId: payload.traceId }), {
												orgId: tenant.orgId,
											}),
											{ profile: "discovery", context: "spanHierarchyProbe" },
										)
										.pipe(Effect.map(Option.getOrNull)),
									"spanHierarchy probe failed",
								)
								if (probe?.timestamp != null) {
									const window = partitionWindowAround(probe.timestamp)
									startTime = window.startTime
									endTime = window.endTime
								}
							}
							const narrowByTime = startTime != null && endTime != null
							const compiled = CH.compile(
								CH.spanHierarchyQuery({
									traceId: payload.traceId,
									spanId: payload.spanId,
									narrowByTime,
								}),
								narrowByTime
									? { orgId: tenant.orgId, startTime, endTime }
									: { orgId: tenant.orgId },
							)
							return yield* mapExecError(
								warehouse.compiledQuery(tenant, compiled, {
									profile: "list",
									context: "spanHierarchy",
								}),
								"spanHierarchy query failed",
							)
						}),
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
					const narrowByTime = payload.startTime != null && payload.endTime != null
					const compiled = CH.compile(
						CH.spanDetailQuery({
							traceId: payload.traceId,
							spanId: payload.spanId,
							narrowByTime,
						}),
						narrowByTime
							? { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime }
							: { orgId: tenant.orgId },
					)
					const row = yield* queryEngine.cachedDirect(
						tenant,
						"spanDetail",
						payload,
						mapExecError(
							warehouse
								.compiledQueryFirst(tenant, compiled, {
									profile: "discovery",
									context: "spanDetail",
								})
								.pipe(Effect.map(Option.getOrNull)),
							"spanDetail query failed",
						),
					)
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
					const compiled = CH.compile(
						CH.errorsByTypeQuery({
							rootOnly: payload.rootOnly,
							services: payload.services,
							deploymentEnvs: payload.deploymentEnvs,
							fingerprintHashes: payload.fingerprintHashes,
							limit: payload.limit,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "errorsByType",
						}),
						"errorsByType query failed",
					)
					const typedRows = rows
					return new ErrorsByTypeResponse({
						data: typedRows.map((row) => ({
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
					const compiled = CH.compile(
						CH.errorsTimeseriesQuery({
							fingerprintHash: payload.fingerprintHash,
							services: payload.services,
						}),
						{
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
							bucketSeconds: payload.bucketSeconds ?? 3600,
						},
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "errorsTimeseries",
						}),
						"errorsTimeseries query failed",
					)
					const typedRows = rows
					return new ErrorsTimeseriesResponse({
						data: typedRows.map((row) => ({
							bucket: String(row.bucket),
							count: Number(row.count),
						})),
					})
				}),
			)
			.handle("errorsSummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.compile(
						CH.errorsSummaryQuery({
							rootOnly: payload.rootOnly,
							services: payload.services,
							deploymentEnvs: payload.deploymentEnvs,
							fingerprintHashes: payload.fingerprintHashes,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const row = yield* mapExecError(
						warehouse
							.compiledQueryFirst(tenant, compiled, {
								profile: "aggregation",
								context: "errorsSummary",
							})
							.pipe(Effect.map(Option.getOrNull)),
						"errorsSummary query failed",
					)
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
					const compiled = CH.compile(
						CH.errorDetailTracesQuery({
							fingerprintHash: payload.fingerprintHash,
							rootOnly: payload.rootOnly,
							services: payload.services,
							limit: payload.limit,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "list",
							context: "errorDetailTraces",
						}),
						"errorDetailTraces query failed",
					)
					const typedRows = rows
					return new ErrorDetailTracesResponse({
						data: typedRows.map((row) => ({
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
					const compiled = CH.compile(CH.errorRateByServiceQuery(), {
						orgId: tenant.orgId,
						startTime: payload.startTime,
						endTime: payload.endTime,
					})
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "errorRateByService",
						}),
						"errorRateByService query failed",
					)
					const typedRows = rows
					return new ErrorRateByServiceResponse({
						data: typedRows.map((row) => ({
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
					const compiled = CH.compile(
						CH.serviceOverviewQuery({
							environments: payload.environments,
							namespaces: payload.namespaces,
							commitShas: payload.commitShas,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* queryEngine.cachedDirect(
						tenant,
						"serviceOverview",
						payload,
						mapExecError(
							warehouse.compiledQuery(tenant, compiled, {
								profile: "aggregation",
								context: "serviceOverview",
							}),
							"serviceOverview query failed",
						),
					)
					return new ServiceOverviewResponse({ data: rows })
				}),
			)
			.handle("serviceHealthBaseline", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.compile(
						CH.serviceHealthBaselineQuery({
							environments: payload.environments,
							namespaces: payload.namespaces,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* queryEngine.cachedDirect(
						tenant,
						"serviceHealthBaseline",
						payload,
						mapExecError(
							warehouse.compiledQuery(tenant, compiled, {
								profile: "aggregation",
								context: "serviceHealthBaseline",
							}),
							"serviceHealthBaseline query failed",
						),
						// The payload's start/end are floored to the hour upstream
						// (`floorToHour`) and this is a trailing 7-day baseline that
						// changes at most hourly, so the cache key already rotates once
						// an hour — a 1h TTL yields ≤1 recompute/hour per (org, env, ns)
						// instead of every 15s for an ~900ms query.
						3600,
					)
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
					const compiled = CH.compile(
						CH.serviceApdexTimeseriesQuery({
							serviceName: payload.serviceName,
							apdexThresholdMs: payload.apdexThresholdMs,
						}),
						{
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
							bucketSeconds: payload.bucketSeconds ?? 60,
						},
					)
					const rows = yield* queryEngine.cachedDirect(
						tenant,
						"serviceApdex",
						payload,
						mapExecError(
							warehouse.compiledQuery(tenant, compiled, {
								profile: "aggregation",
								context: "serviceApdex",
							}),
							"serviceApdex query failed",
						),
					)
					const typedRows = rows
					return new ServiceApdexResponse({
						data: typedRows.map((row) => ({
							bucket: String(row.bucket),
							totalCount: Number(row.totalCount),
							satisfiedCount: Number(row.satisfiedCount),
							toleratingCount: Number(row.toleratingCount),
							apdexScore: Number(row.apdexScore),
						})),
					})
				}),
			)
			.handle("serviceDependencies", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.serviceDependenciesSQL(
						{ deploymentEnv: payload.deploymentEnv },
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "serviceDependencies",
						}),
						"serviceDependencies query failed",
					)
					return new ServiceDependenciesResponse({ data: rows.map((row) => ({ ...row })) })
				}),
			)
			.handle("serviceDependenciesForService", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.compile(
						CH.serviceDependenciesForServiceQuery({
							serviceName: payload.serviceName,
							deploymentEnv: payload.deploymentEnv,
						}),
						{
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
						},
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "serviceDependenciesForService",
						}),
						"serviceDependenciesForService query failed",
					)
					return new ServiceDependenciesResponse({ data: rows })
				}),
			)
			.handle("serviceDbEdges", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.serviceDbEdgesSQL(
						{ deploymentEnv: payload.deploymentEnv },
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "serviceDbEdges",
						}),
						"serviceDbEdges query failed",
					)
					return new ServiceDbEdgesResponse({ data: rows.map((row) => ({ ...row })) })
				}),
			)
			.handle("serviceDbEdgesForService", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.compile(
						CH.serviceDbEdgesForServiceQuery({
							serviceName: payload.serviceName,
							deploymentEnv: payload.deploymentEnv,
						}),
						{
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
						},
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "serviceDbEdgesForService",
						}),
						"serviceDbEdgesForService query failed",
					)
					return new ServiceDbEdgesResponse({ data: rows })
				}),
			)
			.handle("serviceDetailOverview", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context

					const releasesCompiled = CH.compile(
						CH.serviceReleasesTimelineQuery({ serviceName: payload.serviceName }),
						{
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
							bucketSeconds: payload.releasesBucketSeconds ?? 300,
						},
					)
					const environmentsCompiled = CH.compile(
						CH.serviceEnvironmentsQuery({ serviceName: payload.serviceName }),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)

					// One Worker invocation for the whole Overview tab: per-org config
					// resolves once (the first sub-query warms the in-isolate memo) and
					// the three queries run concurrently, replacing three separate
					// browser->Worker round-trips. The primary chart keeps its own
					// execute-path cache; releases is uncached (mirrors the standalone
					// handler); environments is edge-cached on a service-scoped key.
					const [timeseries, releaseRows, environmentRows] = yield* Effect.all(
						[
							queryEngine.execute(tenant, payload.timeseries),
							mapExecError(
								warehouse.compiledQuery(tenant, releasesCompiled, {
									profile: "list",
									context: "serviceReleases",
								}),
								"serviceReleases query failed",
							),
							queryEngine.cachedDirect(
								tenant,
								"serviceEnvironments",
								{
									serviceName: payload.serviceName,
									startTime: payload.startTime,
									endTime: payload.endTime,
								},
								mapExecError(
									warehouse.compiledQuery(tenant, environmentsCompiled, {
										profile: "discovery",
										context: "serviceEnvironments",
									}),
									"serviceEnvironments query failed",
								),
							),
						],
						{ concurrency: 3 },
					)

					return new ServiceDetailOverviewResponse({
						timeseries,
						releases: releaseRows.map((row) => ({
							bucket: String(row.bucket),
							commitSha: decodeCommitSha(row.commitSha),
							count: Number(row.count),
						})),
						environments: environmentRows
							.map((row) => String(row.environment ?? ""))
							.filter((env) => env !== ""),
					})
				}),
			)
			.handle("serviceDependenciesBundle", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context

					const dependenciesCompiled = CH.compile(
						CH.serviceDependenciesForServiceQuery({
							serviceName: payload.serviceName,
							deploymentEnv: payload.deploymentEnv,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const dbEdgesCompiled = CH.compile(
						CH.serviceDbEdgesForServiceQuery({
							serviceName: payload.serviceName,
							deploymentEnv: payload.deploymentEnv,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const externalEdgesCompiled = CH.serviceExternalEdgesSQL(
						{ deploymentEnv: payload.deploymentEnv, serviceName: payload.serviceName },
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)

					// Dependencies tab in one Worker invocation: the three service-map
					// edge queries run concurrently and share a single config
					// resolution, replacing three independent round-trips.
					const [dependencyRows, dbEdgeRows, externalEdgeRows] = yield* Effect.all(
						[
							mapExecError(
								warehouse.compiledQuery(tenant, dependenciesCompiled, {
									profile: "aggregation",
									context: "serviceDependenciesForService",
								}),
								"serviceDependenciesForService query failed",
							),
							mapExecError(
								warehouse.compiledQuery(tenant, dbEdgesCompiled, {
									profile: "aggregation",
									context: "serviceDbEdgesForService",
								}),
								"serviceDbEdgesForService query failed",
							),
							mapExecError(
								warehouse.compiledQuery(tenant, externalEdgesCompiled, {
									profile: "aggregation",
									context: "serviceExternalEdges",
								}),
								"serviceExternalEdges query failed",
							),
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
			.handle("serviceDbQuerySummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const params = {
						orgId: tenant.orgId,
						dbSystem: payload.dbSystem,
						startTime: payload.startTime,
						endTime: payload.endTime,
						sourceService: payload.sourceService,
						deploymentEnv: payload.deploymentEnv,
						bucketSeconds: payload.bucketSeconds,
						topN: payload.topN,
					}
					const summaryCompiled = CH.serviceDbQuerySummarySQL(params)
					const timeseriesCompiled = CH.serviceDbQueryTimeseriesSQL(params)
					const topQueriesCompiled = CH.serviceDbTopQueriesSQL(params)

					const [summary, timeseriesRows, topQueryRows] = yield* Effect.all(
						[
							mapExecError(
								warehouse
									.compiledQueryFirst(tenant, summaryCompiled, {
										profile: "aggregation",
										context: "serviceDbQuerySummary",
									})
									.pipe(Effect.map(Option.getOrNull)),
								"serviceDbQuerySummary query failed",
							),
							mapExecError(
								warehouse.compiledQuery(tenant, timeseriesCompiled, {
									profile: "aggregation",
									context: "serviceDbQueryTimeseries",
								}),
								"serviceDbQueryTimeseries query failed",
							),
							mapExecError(
								warehouse.compiledQuery(tenant, topQueriesCompiled, {
									profile: "aggregation",
									context: "serviceDbTopQueries",
								}),
								"serviceDbTopQueries query failed",
							),
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
			.handle("serviceExternalEdges", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.serviceExternalEdgesSQL(
						{
							deploymentEnv: payload.deploymentEnv,
							serviceName: payload.serviceName,
						},
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "serviceExternalEdges",
						}),
						"serviceExternalEdges query failed",
					)
					return new ServiceExternalEdgesResponse({ data: rows.map((row) => ({ ...row })) })
				}),
			)
			.handle("servicePlatforms", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.servicePlatformsSQL(
						{ deploymentEnv: payload.deploymentEnv },
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "servicePlatforms",
						}),
						"servicePlatforms query failed",
					)
					return new ServicePlatformsResponse({
						data: rows.map((row) => {
							const k8sCluster = String(row.k8sCluster ?? "")
							const k8sPodName = String(row.k8sPodName ?? "")
							const k8sDeploymentName = String(row.k8sDeploymentName ?? "")
							const cloudPlatform = String(row.cloudPlatform ?? "")
							const cloudProvider = String(row.cloudProvider ?? "")
							const faasName = String(row.faasName ?? "")
							const mapleSdkType = String(row.mapleSdkType ?? "")
							const processRuntimeName = String(row.processRuntimeName ?? "")
							// Require pod/deployment, not just cluster.name — see SQL comment.
							const isKubernetes = k8sPodName !== "" || k8sDeploymentName !== ""
							// Infrastructure signals win over SDK self-report so a server SDK on
							// cloudflare/lambda still classifies by host. Pure browser apps never
							// set k8s/cloud/faas, so they fall through to web.
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
						}),
					})
				}),
			)
			.handle("serviceWorkloads", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					if (payload.services.length === 0) {
						return new ServiceWorkloadsResponse({ data: [] })
					}
					const compiled = CH.serviceWorkloadsSQL(
						{ services: payload.services },
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "serviceWorkloads",
						}),
						"serviceWorkloads query failed",
					)
					return new ServiceWorkloadsResponse({
						data: rows.map((row) => ({
							serviceName: decodeServiceName(String(row.serviceName ?? "")),
							workloadKind: row.workloadKind,
							workloadName: String(row.workloadName ?? ""),
							namespace: String(row.namespace ?? ""),
							clusterName: String(row.clusterName ?? ""),
							podCount: Number(row.podCount) || 0,
							avgCpuLimitUtilization:
								row.avgCpuLimitUtilization == null
									? null
									: Number(row.avgCpuLimitUtilization),
							avgMemoryLimitUtilization:
								row.avgMemoryLimitUtilization == null
									? null
									: Number(row.avgMemoryLimitUtilization),
						})),
					})
				}),
			)
			.handle("serviceUsage", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const prevStart = payload.previousStartTime
					const prevEnd = payload.previousEndTime
					const compiled =
						prevStart != null && prevEnd != null
							? CH.compile(CH.serviceUsageWithPreviousQuery({ serviceName: payload.service }), {
									orgId: tenant.orgId,
									startTime: payload.startTime,
									endTime: payload.endTime,
									previousStartTime: prevStart,
									previousEndTime: prevEnd,
								})
							: CH.compile(CH.serviceUsageQuery({ serviceName: payload.service }), {
									orgId: tenant.orgId,
									startTime: payload.startTime,
									endTime: payload.endTime,
								})
					const rows = yield* queryEngine.cachedDirect(
						tenant,
						"serviceUsage",
						payload,
						mapExecError(
							warehouse.compiledQuery(tenant, compiled, {
								profile: "aggregation",
								context: "serviceUsage",
							}),
							"serviceUsage query failed",
						),
						// Usage totals (GB / session counts) tolerate a minute of
						// staleness; a 60s TTL cuts repeat-load recomputes ~4× vs 15s.
						60,
					)
					return new ServiceUsageResponse({ data: rows })
				}),
			)
			.handle("listLogs", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.compile(
						CH.logsListQuery({
							serviceName: payload.service,
							severity: payload.severity,
							minSeverity: payload.minSeverity,
							traceId: payload.traceId,
							spanId: payload.spanId,
							cursor: payload.cursor,
							search: payload.search,
							environments: payload.deploymentEnv ? [payload.deploymentEnv] : undefined,
							namespaces: payload.namespace ? [payload.namespace] : undefined,
							matchModes: Match.value([
								payload.deploymentEnvMatchMode,
								payload.namespaceMatchMode,
							] as const).pipe(
								Match.when([undefined, undefined], () => undefined),
								Match.orElse(([deploymentEnv, serviceNamespace]) => ({
									deploymentEnv,
									serviceNamespace,
								})),
							),
							limit: payload.limit,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* queryEngine.cachedDirect(
						tenant,
						"listLogs",
						payload,
						mapExecError(
							warehouse.compiledQuery(tenant, compiled, {
								profile: "list",
								context: "listLogs",
								// Body search reads the wide Body column for the ILIKE
								// filter — cap the read block size (see
								// WarehouseQuerySettings.maxBlockSize).
								settings: payload.search ? LOGS_BODY_SEARCH_SETTINGS : undefined,
							}),
							"listLogs query failed",
						),
					)
					return new ListLogsResponse({ data: rows })
				}),
			)
			.handle("getLog", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// Bound the scan to a ±1h window around the requested log so
					// ClickHouse can prune partitions instead of reading every
					// retained daily partition for an exact-timestamp match.
					const { startTime, endTime } = partitionWindowAround(payload.timestamp)
					const compiled = CH.compile(
						CH.getLogByKeyQuery({
							serviceName: payload.serviceName,
							traceId: payload.traceId,
							spanId: payload.spanId,
						}),
						{ orgId: tenant.orgId, startTime, endTime, timestamp: payload.timestamp },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "list",
							context: "getLog",
						}),
						"getLog query failed",
					)
					return new GetLogResponse({ data: rows })
				}),
			)
			.handle("listMetrics", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.compile(
						CH.listMetricsQuery({
							serviceName: payload.service,
							metricType: payload.metricType,
							search: payload.search,
							limit: payload.limit,
							offset: payload.offset,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "discovery",
							context: "listMetrics",
						}),
						"listMetrics query failed",
					)
					return new ListMetricsResponse({ data: rows })
				}),
			)
			.handle("metricsSummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.compile(CH.metricsSummaryQuery({ serviceName: payload.service }), {
						orgId: tenant.orgId,
						startTime: payload.startTime,
						endTime: payload.endTime,
					})
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "discovery",
							context: "metricsSummary",
						}),
						"metricsSummary query failed",
					)
					const typedRows = rows
					return new MetricsSummaryResponse({
						data: typedRows.map((row) => ({
							metricType: row.metricType,
							metricCount: Number(row.metricCount),
							dataPointCount: Number(row.dataPointCount),
						})),
					})
				}),
			)
			.handle("executeQueryBuilder", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const enabledQueries = payload.queries.filter((q) => q.enabled)

					if (enabledQueries.length === 0) {
						return yield* Effect.fail(
							new QueryEngineValidationError({
								message: "No enabled queries in request",
								details: ["At least one query must be enabled"],
							}),
						)
					}

					const allWarnings: string[] = []

					if (payload.kind === "timeseries") {
						// Build a spec per query, execute each, then merge series across queries.
						// Series names are namespaced by the query's display name when there are
						// multiple queries, otherwise we keep the raw group names from the query
						// engine result so single-query widgets render naturally.
						type Point = { bucket: string; series: Record<string, number> }
						const perQueryPoints: Array<{ name: string; points: Point[] }> = []

						yield* Effect.forEach(enabledQueries, (query) =>
							Effect.gen(function* () {
								const built = buildTimeseriesQuerySpec(query)
								for (const w of built.warnings) allWarnings.push(`${query.name}: ${w}`)

								if (!built.query) {
									if (built.error) allWarnings.push(`${query.name}: ${built.error}`)
									return
								}

								const request = new QueryEngineExecuteRequest({
									startTime: payload.startTime,
									endTime: payload.endTime,
									query: built.query,
								})

								const response = yield* queryEngine.execute(tenant, request)
								if (response.result.kind !== "timeseries") {
									allWarnings.push(`${query.name}: unexpected non-timeseries result`)
									return
								}

								perQueryPoints.push({
									name: query.legend?.trim() || query.name,
									points: response.result.data.map((p) => ({
										bucket: p.bucket,
										series: { ...p.series },
									})),
								})
							}),
						)

						const multiQuery = perQueryPoints.length > 1
						const rowsByBucket = new Map<string, Record<string, number>>()
						for (const { name: queryName, points } of perQueryPoints) {
							for (const point of points) {
								const row = rowsByBucket.get(point.bucket) ?? {}
								for (const [groupName, value] of Object.entries(point.series)) {
									if (typeof value !== "number" || !Number.isFinite(value)) continue
									const isAllGroup = groupName.toLowerCase() === "all"
									const seriesKey = multiQuery
										? isAllGroup
											? queryName
											: `${queryName}: ${groupName}`
										: isAllGroup
											? queryName
											: groupName
									row[seriesKey] = value
								}
								rowsByBucket.set(point.bucket, row)
							}
						}

						const merged = [...rowsByBucket.entries()]
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([bucket, series]) => ({ bucket, series }))

						return new ExecuteQueryBuilderResponse({
							result: { kind: "timeseries", data: merged },
							warnings: allWarnings.length > 0 ? allWarnings : undefined,
						})
					}

					// Breakdown: take just the first enabled query (matches the web's behaviour
					// for single-query breakdown widgets — multi-query breakdowns aren't a thing
					// in the dashboard builder yet).
					const primary = enabledQueries[0]
					const built = buildBreakdownQuerySpec(primary)
					for (const w of built.warnings) allWarnings.push(`${primary.name}: ${w}`)

					if (!built.query) {
						return yield* Effect.fail(
							new QueryEngineValidationError({
								message: built.error ?? "Failed to build breakdown query",
								details: built.error ? [built.error] : [],
							}),
						)
					}

					const request = new QueryEngineExecuteRequest({
						startTime: payload.startTime,
						endTime: payload.endTime,
						query: built.query,
					})

					const response = yield* queryEngine.execute(tenant, request)
					if (response.result.kind !== "breakdown") {
						return yield* Effect.fail(
							new QueryEngineExecutionError({
								message: "Unexpected non-breakdown result",
							}),
						)
					}

					return new ExecuteQueryBuilderResponse({
						result: {
							kind: "breakdown",
							data: response.result.data.map((item) => ({
								name: item.name,
								value: item.value,
							})),
						},
						warnings: allWarnings.length > 0 ? allWarnings : undefined,
					})
				}),
			)
			.handle("listHosts", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.compile(
						CH.listHostsQuery({
							search: payload.search,
							limit: payload.limit,
							offset: payload.offset,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, { profile: "list", context: "listHosts" }),
						"listHosts query failed",
					)
					const typedRows = rows
					return new ListHostsResponse({
						data: typedRows.map((row) => ({
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
					const compiled = CH.compile(CH.hostDetailSummaryQuery({ hostName: payload.hostName }), {
						orgId: tenant.orgId,
						startTime: payload.startTime,
						endTime: payload.endTime,
					})
					const row = yield* mapExecError(
						warehouse
							.compiledQueryFirst(tenant, compiled, {
								profile: "aggregation",
								context: "hostDetailSummary",
							})
							.pipe(Effect.map(Option.getOrNull)),
						"hostDetailSummary query failed",
					)
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
					const bucketSeconds = payload.bucketSeconds ?? 300
					const compiled = CH.compile(CH.fleetUtilizationTimeseriesQuery(), {
						orgId: tenant.orgId,
						startTime: payload.startTime,
						endTime: payload.endTime,
						bucketSeconds,
					})
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "fleetUtilizationTimeseries",
						}),
						"fleetUtilizationTimeseries query failed",
					)
					const typedRows = rows
					return new FleetUtilizationTimeseriesResponse({
						data: typedRows.map((row) => ({
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

					const spec = (() => {
						switch (payload.metric) {
							case "cpu":
								return {
									metricName: "system.cpu.utilization",
									groupByAttributeKey: "state",
									unit: "percent" as const,
									isNetwork: false,
								}
							case "memory":
								return {
									metricName: "system.memory.utilization",
									groupByAttributeKey: "state",
									unit: "percent" as const,
									isNetwork: false,
								}
							case "filesystem":
								return {
									metricName: "system.filesystem.utilization",
									groupByAttributeKey: "mountpoint",
									unit: "percent" as const,
									isNetwork: false,
								}
							case "load15":
								return {
									metricName: "system.cpu.load_average.15m",
									groupByAttributeKey: undefined,
									unit: "load" as const,
									isNetwork: false,
								}
							case "network":
								return {
									metricName: "system.network.io",
									groupByAttributeKey: "direction",
									unit: "bytes_per_second" as const,
									isNetwork: true,
								}
						}
					})()

					if (spec.isNetwork) {
						const compiled = CH.compile(
							CH.hostNetworkTimeseriesQuery({ hostName: payload.hostName }),
							{
								orgId: tenant.orgId,
								startTime: payload.startTime,
								endTime: payload.endTime,
								bucketSeconds,
							},
						)
						const rows = yield* mapExecError(
							warehouse.compiledQuery(tenant, compiled, {
								profile: "aggregation",
								context: "hostInfraTimeseries",
							}),
							"hostInfraTimeseries (network) query failed",
						)
						const typedRows = rows
						return new HostInfraTimeseriesResponse({
							data: typedRows.map((row) => ({
								bucket: String(row.bucket),
								attributeValue: String(row.attributeValue ?? ""),
								value: Number(row.sumValue) || 0,
							})),
							groupByAttributeKey: spec.groupByAttributeKey,
							unit: spec.unit,
						})
					}

					const compiled = CH.compile(
						CH.hostGaugeTimeseriesQuery({
							hostName: payload.hostName,
							metricName: spec.metricName,
							groupByAttributeKey: spec.groupByAttributeKey,
						}),
						{
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
							bucketSeconds,
						},
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "hostInfraTimeseries",
						}),
						"hostInfraTimeseries query failed",
					)
					const typedRows = rows
					return new HostInfraTimeseriesResponse({
						data: typedRows.map((row) => ({
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
					const compiled = CH.compile(
						CH.listPodsQuery({
							search: payload.search,
							podNames: payload.podNames,
							namespaces: payload.namespaces,
							nodeNames: payload.nodeNames,
							clusters: payload.clusters,
							deployments: payload.deployments,
							statefulsets: payload.statefulsets,
							daemonsets: payload.daemonsets,
							jobs: payload.jobs,
							environments: payload.environments,
							computeTypes: payload.computeTypes,
							workloadKind: payload.workloadKind,
							workloadName: payload.workloadName,
							limit: payload.limit,
							offset: payload.offset,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, { profile: "list", context: "listPods" }),
						"listPods query failed",
					)
					const typedRows = rows
					return new ListPodsResponse({
						data: typedRows.map((row) => ({
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
						})),
					})
				}),
			)
			.handle("podDetailSummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.compile(
						CH.podDetailSummaryQuery({ podName: payload.podName, namespace: payload.namespace }),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const row = yield* mapExecError(
						warehouse
							.compiledQueryFirst(tenant, compiled, {
								profile: "aggregation",
								context: "podDetailSummary",
							})
							.pipe(Effect.map(Option.getOrNull)),
						"podDetailSummary query failed",
					)
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
					const bucketSeconds = payload.bucketSeconds ?? 60

					const spec = (() => {
						switch (payload.metric) {
							case "cpu_usage":
								return { metricName: "k8s.pod.cpu.usage", unit: "cores" as const }
							case "cpu_limit":
								return {
									metricName: "k8s.pod.cpu_limit_utilization",
									unit: "percent" as const,
								}
							case "cpu_request":
								return {
									metricName: "k8s.pod.cpu_request_utilization",
									unit: "percent" as const,
								}
							case "memory_limit":
								return {
									metricName: "k8s.pod.memory_limit_utilization",
									unit: "percent" as const,
								}
							case "memory_request":
								return {
									metricName: "k8s.pod.memory_request_utilization",
									unit: "percent" as const,
								}
						}
					})()

					const compiled = CH.compile(
						CH.podGaugeTimeseriesQuery({
							podName: payload.podName,
							namespace: payload.namespace,
							metricName: spec.metricName,
						}),
						{
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
							bucketSeconds,
						},
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "podInfraTimeseries",
						}),
						"podInfraTimeseries query failed",
					)
					const typedRows = rows
					return new PodInfraTimeseriesResponse({
						data: typedRows.map((row) => ({
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
					const compiled = CH.compile(
						CH.listNodesQuery({
							search: payload.search,
							nodeNames: payload.nodeNames,
							clusters: payload.clusters,
							environments: payload.environments,
							limit: payload.limit,
							offset: payload.offset,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, { profile: "list", context: "listNodes" }),
						"listNodes query failed",
					)
					const typedRows = rows
					return new ListNodesResponse({
						data: typedRows.map((row) => ({
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
					const compiled = CH.compile(CH.nodeDetailSummaryQuery({ nodeName: payload.nodeName }), {
						orgId: tenant.orgId,
						startTime: payload.startTime,
						endTime: payload.endTime,
					})
					const row = yield* mapExecError(
						warehouse
							.compiledQueryFirst(tenant, compiled, {
								profile: "aggregation",
								context: "nodeDetailSummary",
							})
							.pipe(Effect.map(Option.getOrNull)),
						"nodeDetailSummary query failed",
					)
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
					const bucketSeconds = payload.bucketSeconds ?? 60

					const spec = (() => {
						switch (payload.metric) {
							case "cpu_usage":
								return { metricName: "k8s.node.cpu.usage", unit: "cores" as const }
							case "uptime":
								return { metricName: "k8s.node.uptime", unit: "seconds" as const }
						}
					})()

					const compiled = CH.compile(
						CH.nodeGaugeTimeseriesQuery({
							nodeName: payload.nodeName,
							metricName: spec.metricName,
						}),
						{
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
							bucketSeconds,
						},
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "nodeInfraTimeseries",
						}),
						"nodeInfraTimeseries query failed",
					)
					const typedRows = rows
					return new NodeInfraTimeseriesResponse({
						data: typedRows.map((row) => ({
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
					const compiled = CH.compile(
						CH.listWorkloadsQuery({
							kind: payload.kind,
							search: payload.search,
							workloadNames: payload.workloadNames,
							namespaces: payload.namespaces,
							clusters: payload.clusters,
							environments: payload.environments,
							computeTypes: payload.computeTypes,
							limit: payload.limit,
							offset: payload.offset,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "list",
							context: "listWorkloads",
						}),
						"listWorkloads query failed",
					)
					const typedRows = rows
					return new ListWorkloadsResponse({
						data: typedRows.map((row) => ({
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
					const compiled = CH.compile(
						CH.workloadDetailSummaryQuery({
							kind: payload.kind,
							workloadName: payload.workloadName,
							namespace: payload.namespace,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const row = yield* mapExecError(
						warehouse
							.compiledQueryFirst(tenant, compiled, {
								profile: "aggregation",
								context: "workloadDetailSummary",
							})
							.pipe(Effect.map(Option.getOrNull)),
						"workloadDetailSummary query failed",
					)
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
					const bucketSeconds = payload.bucketSeconds ?? 60

					const spec = (() => {
						switch (payload.metric) {
							case "cpu_usage":
								return { metricName: "k8s.pod.cpu.usage", unit: "cores" as const }
							case "cpu_limit":
								return {
									metricName: "k8s.pod.cpu_limit_utilization",
									unit: "percent" as const,
								}
							case "memory_limit":
								return {
									metricName: "k8s.pod.memory_limit_utilization",
									unit: "percent" as const,
								}
						}
					})()

					const compiled = CH.compile(
						CH.workloadGaugeTimeseriesQuery({
							kind: payload.kind,
							workloadName: payload.workloadName,
							namespace: payload.namespace,
							metricName: spec.metricName,
							groupByPod: payload.groupByPod,
						}),
						{
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
							bucketSeconds,
						},
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "aggregation",
							context: "workloadInfraTimeseries",
						}),
						"workloadInfraTimeseries query failed",
					)
					const typedRows = rows
					return new WorkloadInfraTimeseriesResponse({
						data: typedRows.map((row) => ({
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
					const compiled = CH.compileUnion(
						CH.podFacetsQuery({
							search: payload.search,
							podNames: payload.podNames,
							namespaces: payload.namespaces,
							nodeNames: payload.nodeNames,
							clusters: payload.clusters,
							deployments: payload.deployments,
							statefulsets: payload.statefulsets,
							daemonsets: payload.daemonsets,
							jobs: payload.jobs,
							environments: payload.environments,
							computeTypes: payload.computeTypes,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "discovery",
							// 10 UNION branches each re-read the wide ResourceAttributes Map column;
							// cap read-thread concurrency so the per-thread decompression buffers stay
							// inside the discovery memory budget (bound is ~independent of time range).
							settings: { maxThreads: 4 },
							context: "podFacets",
						}),
						"podFacets query failed",
					)
					const typedRows = rows
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
					for (const row of typedRows) {
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
					const compiled = CH.compileUnion(
						CH.nodeFacetsQuery({
							search: payload.search,
							nodeNames: payload.nodeNames,
							clusters: payload.clusters,
							environments: payload.environments,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "discovery",
							// See podFacets: cap read-thread concurrency to bound Map-column
							// decompression memory across the fan-out of UNION branches.
							settings: { maxThreads: 4 },
							context: "nodeFacets",
						}),
						"nodeFacets query failed",
					)
					const typedRows = rows
					const buckets = {
						nodes: [] as Array<{ name: string; count: number }>,
						clusters: [] as Array<{ name: string; count: number }>,
						environments: [] as Array<{ name: string; count: number }>,
					}
					for (const row of typedRows) {
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
					const compiled = CH.compileUnion(
						CH.workloadFacetsQuery({
							kind: payload.kind,
							search: payload.search,
							workloadNames: payload.workloadNames,
							namespaces: payload.namespaces,
							clusters: payload.clusters,
							environments: payload.environments,
							computeTypes: payload.computeTypes,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.compiledQuery(tenant, compiled, {
							profile: "discovery",
							// See podFacets: cap read-thread concurrency to bound Map-column
							// decompression memory across the fan-out of UNION branches.
							settings: { maxThreads: 4 },
							context: "workloadFacets",
						}),
						"workloadFacets query failed",
					)
					const typedRows = rows
					const buckets = {
						workloads: [] as Array<{ name: string; count: number }>,
						namespaces: [] as Array<{ name: string; count: number }>,
						clusters: [] as Array<{ name: string; count: number }>,
						environments: [] as Array<{ name: string; count: number }>,
						computeTypes: [] as Array<{ name: string; count: number }>,
					}
					for (const row of typedRows) {
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
			.handle("executeRawSql", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context

					const autoBucketSeconds = computeAutoBucketSeconds(payload.startTime, payload.endTime)
					const granularitySeconds = payload.granularitySeconds ?? autoBucketSeconds

					const expanded = yield* rawSqlChart.expandMacros({
						sql: payload.sql,
						orgId: tenant.orgId,
						startTime: payload.startTime,
						endTime: payload.endTime,
						granularitySeconds,
					})

					const profile: "aggregation" | "list" =
						payload.displayType === "table" ? "list" : "aggregation"
					const rows = yield* mapExecError(
						warehouse.sqlQuery(tenant, expanded.sql, {
							profile,
							context: "rawSql",
						}),
						"rawSql query failed",
					)

					const records = rows as ReadonlyArray<Record<string, unknown>>
					const columns = records.length > 0 ? Object.keys(records[0]) : []

					return new RawSqlExecuteResponse({
						data: records,
						meta: {
							rowCount: records.length,
							columns,
							granularitySeconds: expanded.granularitySeconds,
						},
					})
				}),
			)
	}),
)

// ---------------------------------------------------------------------------
// Auto-bucket helper for raw-SQL $__interval_s when the user didn't supply
// granularitySeconds. Mirrors apps/web/src/api/tinybird/timeseries-utils.ts so
// the backend can compute it without depending on the web package.
// ---------------------------------------------------------------------------

const TARGET_POINTS = 30
const AUTO_BUCKET_LADDER = [300, 900, 1800, 3600, 14400, 86400] as const

function computeAutoBucketSeconds(startTime: string, endTime: string): number {
	const toEpochMs = (value: string) => new Date(value.replace(" ", "T") + "Z").getTime()
	const startMs = toEpochMs(startTime)
	const endMs = toEpochMs(endTime)
	if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
		return 300
	}
	const rangeSeconds = Math.max((endMs - startMs) / 1000, 1)
	const raw = Math.ceil(rangeSeconds / TARGET_POINTS)
	return AUTO_BUCKET_LADDER.reduce(
		(best, candidate) => (Math.abs(candidate - raw) < Math.abs(best - raw) ? candidate : best),
		AUTO_BUCKET_LADDER[0],
	)
}
