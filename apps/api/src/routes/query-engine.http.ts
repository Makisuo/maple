import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
	CurrentTenant,
	ExecuteQueryBuilderResponse,
	MapleApi,
	QueryEngineExecutionError,
	QueryEngineValidationError,
	RawSqlExecuteResponse,
	RawSqlValidationError,
	TinybirdQueryError,
	TinybirdQuotaExceededError,
	SpanHierarchyResponse,
	ErrorsByTypeResponse,
	ErrorsTimeseriesResponse,
	ErrorsSummaryResponse,
	ErrorDetailTracesResponse,
	ErrorRateByServiceResponse,
	ServiceOverviewResponse,
	ServiceApdexResponse,
	ServiceReleasesResponse,
	ServiceDependenciesResponse,
	ServiceDbEdgesResponse,
	ServicePlatformsResponse,
	ServiceWorkloadsResponse,
	ServiceUsageResponse,
	ListLogsResponse,
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
	SpanId,
	TraceId,
} from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { QueryEngineService, type QueryEngineDirectError } from "../services/QueryEngineService"
import { RawSqlChartService } from "../services/RawSqlChartService"
import { WarehouseQueryService } from "../services/WarehouseQueryService"
import { CH, QueryEngineExecuteRequest } from "@maple/query-engine"
import { buildBreakdownQuerySpec, buildTimeseriesQuerySpec } from "@maple/query-engine/query-builder"

const isTaggedHttpError = (value: unknown): value is TinybirdQueryError | TinybirdQuotaExceededError =>
	value instanceof TinybirdQueryError || value instanceof TinybirdQuotaExceededError

const decodeTraceIdSync = Schema.decodeUnknownSync(TraceId)
const decodeSpanIdSync = Schema.decodeUnknownSync(SpanId)
const decodeParentSpanId = (value: string) => (value === "" ? "" : decodeSpanIdSync(value))

const mapExecError = <A, R>(
	effect: Effect.Effect<A, QueryEngineDirectError, R>,
	context: string,
): Effect.Effect<A, QueryEngineExecutionError | TinybirdQueryError | TinybirdQuotaExceededError, R> =>
	effect.pipe(
		Effect.mapError((cause) => {
			if (isTaggedHttpError(cause)) {
				return cause
			}
			return new QueryEngineExecutionError({
				message: context,
				causeMessage: cause instanceof Error ? cause.message : String(cause),
			})
		}),
	)

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
					const narrowByTime = payload.startTime != null && payload.endTime != null
					const compiled = CH.compile(
						CH.spanHierarchyQuery({
							traceId: payload.traceId,
							spanId: payload.spanId,
							narrowByTime,
						}),
						narrowByTime
							? { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime }
							: { orgId: tenant.orgId },
					)
					const rows = yield* queryEngine.cachedDirect(
						tenant,
						"spanHierarchy",
						payload,
						mapExecError(
							warehouse.sqlQuery(tenant, compiled.sql, {
								profile: "list",
								context: "spanHierarchy",
							}),
							"spanHierarchy query failed",
						),
					)
					const typedRows = compiled.castRows(rows)
					return new SpanHierarchyResponse({
						data: typedRows.map((row) => ({
							...row,
							traceId: decodeTraceIdSync(row.traceId),
							spanId: decodeSpanIdSync(row.spanId),
							parentSpanId: decodeParentSpanId(row.parentSpanId),
						})),
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
							errorTypes: payload.errorTypes,
							limit: payload.limit,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "errorsByType",
						}),
						"errorsByType query failed",
					)
					const typedRows = compiled.castRows(rows)
					return new ErrorsByTypeResponse({
						data: typedRows.map((row) => ({
							errorType: row.errorType,
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
							errorType: payload.errorType,
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "errorsTimeseries",
						}),
						"errorsTimeseries query failed",
					)
					const typedRows = compiled.castRows(rows)
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
							errorTypes: payload.errorTypes,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "errorsSummary",
						}),
						"errorsSummary query failed",
					)
					const typedRows = compiled.castRows(rows)
					return new ErrorsSummaryResponse({
						data: typedRows[0]
							? {
									totalErrors: Number(typedRows[0].totalErrors),
									totalSpans: Number(typedRows[0].totalSpans),
									errorRate: Number(typedRows[0].errorRate),
									affectedServicesCount: Number(typedRows[0].affectedServicesCount),
									affectedTracesCount: Number(typedRows[0].affectedTracesCount),
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
							errorType: payload.errorType,
							rootOnly: payload.rootOnly,
							services: payload.services,
							limit: payload.limit,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "list",
							context: "errorDetailTraces",
						}),
						"errorDetailTraces query failed",
					)
					const typedRows = compiled.castRows(rows)
					return new ErrorDetailTracesResponse({
						data: typedRows.map((row) => ({
							traceId: decodeTraceIdSync(row.traceId),
							startTime: String(row.startTime),
							durationMicros: Number(row.durationMicros),
							spanCount: Number(row.spanCount),
							services: row.services,
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "errorRateByService",
						}),
						"errorRateByService query failed",
					)
					const typedRows = compiled.castRows(rows)
					return new ErrorRateByServiceResponse({
						data: typedRows.map((row) => ({
							serviceName: row.serviceName,
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
							commitShas: payload.commitShas,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* queryEngine.cachedDirect(
						tenant,
						"serviceOverview",
						payload,
						mapExecError(
							warehouse.sqlQuery(tenant, compiled.sql, {
								profile: "aggregation",
								context: "serviceOverview",
							}),
							"serviceOverview query failed",
						),
					)
					return new ServiceOverviewResponse({ data: rows as any[] })
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
							warehouse.sqlQuery(tenant, compiled.sql, {
								profile: "aggregation",
								context: "serviceApdex",
							}),
							"serviceApdex query failed",
						),
					)
					const typedRows = compiled.castRows(rows)
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
			.handle("serviceReleases", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.compile(
						CH.serviceReleasesTimelineQuery({ serviceName: payload.serviceName }),
						{
							orgId: tenant.orgId,
							startTime: payload.startTime,
							endTime: payload.endTime,
							bucketSeconds: payload.bucketSeconds ?? 300,
						},
					)
					const rows = yield* mapExecError(
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "list",
							context: "serviceReleases",
						}),
						"serviceReleases query failed",
					)
					const typedRows = compiled.castRows(rows)
					return new ServiceReleasesResponse({
						data: typedRows.map((row) => ({
							bucket: String(row.bucket),
							commitSha: row.commitSha,
							count: Number(row.count),
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "serviceDependencies",
						}),
						"serviceDependencies query failed",
					)
					return new ServiceDependenciesResponse({ data: compiled.castRows(rows) as any[] })
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "serviceDbEdges",
						}),
						"serviceDbEdges query failed",
					)
					return new ServiceDbEdgesResponse({ data: compiled.castRows(rows) as any[] })
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "servicePlatforms",
						}),
						"servicePlatforms query failed",
					)
					const typedRows = compiled.castRows(rows)
					return new ServicePlatformsResponse({
						data: typedRows.map((row) => {
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
								serviceName: String(row.serviceName ?? ""),
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "serviceWorkloads",
						}),
						"serviceWorkloads query failed",
					)
					const typedRows = compiled.castRows(rows)
					return new ServiceWorkloadsResponse({
						data: typedRows.map((row) => ({
							serviceName: String(row.serviceName ?? ""),
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
					const compiled = CH.compile(CH.serviceUsageQuery({ serviceName: payload.service }), {
						orgId: tenant.orgId,
						startTime: payload.startTime,
						endTime: payload.endTime,
					})
					const rows = yield* queryEngine.cachedDirect(
						tenant,
						"serviceUsage",
						payload,
						mapExecError(
							warehouse.sqlQuery(tenant, compiled.sql, {
								profile: "aggregation",
								context: "serviceUsage",
							}),
							"serviceUsage query failed",
						),
					)
					return new ServiceUsageResponse({ data: rows as any[] })
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
							matchModes: payload.deploymentEnvMatchMode
								? { deploymentEnv: payload.deploymentEnvMatchMode }
								: undefined,
							limit: payload.limit,
						}),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* queryEngine.cachedDirect(
						tenant,
						"listLogs",
						payload,
						mapExecError(
							warehouse.sqlQuery(tenant, compiled.sql, {
								profile: "list",
								context: "listLogs",
							}),
							"listLogs query failed",
						),
					)
					return new ListLogsResponse({ data: rows as any[] })
				}),
			)
			.handle("listMetrics", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.compileUnion(
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "discovery",
							context: "listMetrics",
						}),
						"listMetrics query failed",
					)
					return new ListMetricsResponse({ data: rows as any[] })
				}),
			)
			.handle("metricsSummary", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const compiled = CH.compileUnion(
						CH.metricsSummaryQuery({ serviceName: payload.service }),
						{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
					)
					const rows = yield* mapExecError(
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "discovery",
							context: "metricsSummary",
						}),
						"metricsSummary query failed",
					)
					const typedRows = compiled.castRows(rows)
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

						for (const query of enabledQueries) {
							const built = buildTimeseriesQuerySpec(query)
							for (const w of built.warnings) allWarnings.push(`${query.name}: ${w}`)

							if (!built.query) {
								if (built.error) allWarnings.push(`${query.name}: ${built.error}`)
								continue
							}

							const request = new QueryEngineExecuteRequest({
								startTime: payload.startTime,
								endTime: payload.endTime,
								query: built.query,
							})

							const response = yield* queryEngine.execute(tenant, request)
							if (response.result.kind !== "timeseries") {
								allWarnings.push(`${query.name}: unexpected non-timeseries result`)
								continue
							}

							perQueryPoints.push({
								name: query.legend?.trim() || query.name,
								points: response.result.data.map((p) => ({
									bucket: p.bucket,
									series: { ...p.series },
								})),
							})
						}

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
						warehouse.sqlQuery(tenant, compiled.sql, { profile: "list", context: "listHosts" }),
						"listHosts query failed",
					)
					const typedRows = compiled.castRows(rows)
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
					const rows = yield* mapExecError(
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "hostDetailSummary",
						}),
						"hostDetailSummary query failed",
					)
					const typedRows = compiled.castRows(rows)
					const row = typedRows[0]
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "fleetUtilizationTimeseries",
						}),
						"fleetUtilizationTimeseries query failed",
					)
					const typedRows = compiled.castRows(rows)
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
							warehouse.sqlQuery(tenant, compiled.sql, { profile: "aggregation" }),
							"hostInfraTimeseries (network) query failed",
						)
						const typedRows = compiled.castRows(rows)
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "hostInfraTimeseries",
						}),
						"hostInfraTimeseries query failed",
					)
					const typedRows = compiled.castRows(rows)
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
						warehouse.sqlQuery(tenant, compiled.sql, { profile: "list", context: "listPods" }),
						"listPods query failed",
					)
					const typedRows = compiled.castRows(rows)
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
					const rows = yield* mapExecError(
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "podDetailSummary",
						}),
						"podDetailSummary query failed",
					)
					const typedRows = compiled.castRows(rows)
					const row = typedRows[0]
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "podInfraTimeseries",
						}),
						"podInfraTimeseries query failed",
					)
					const typedRows = compiled.castRows(rows)
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
						warehouse.sqlQuery(tenant, compiled.sql, { profile: "list", context: "listNodes" }),
						"listNodes query failed",
					)
					const typedRows = compiled.castRows(rows)
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
					const rows = yield* mapExecError(
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "nodeDetailSummary",
						}),
						"nodeDetailSummary query failed",
					)
					const typedRows = compiled.castRows(rows)
					const row = typedRows[0]
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "nodeInfraTimeseries",
						}),
						"nodeInfraTimeseries query failed",
					)
					const typedRows = compiled.castRows(rows)
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "list",
							context: "listWorkloads",
						}),
						"listWorkloads query failed",
					)
					const typedRows = compiled.castRows(rows)
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
					const rows = yield* mapExecError(
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "workloadDetailSummary",
						}),
						"workloadDetailSummary query failed",
					)
					const typedRows = compiled.castRows(rows)
					const row = typedRows[0]
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "aggregation",
							context: "workloadInfraTimeseries",
						}),
						"workloadInfraTimeseries query failed",
					)
					const typedRows = compiled.castRows(rows)
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "discovery",
							context: "podFacets",
						}),
						"podFacets query failed",
					)
					const typedRows = compiled.castRows(rows) as ReadonlyArray<{
						name: string
						count: number
						facetType: string
					}>
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "discovery",
							context: "nodeFacets",
						}),
						"nodeFacets query failed",
					)
					const typedRows = compiled.castRows(rows) as ReadonlyArray<{
						name: string
						count: number
						facetType: string
					}>
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
						warehouse.sqlQuery(tenant, compiled.sql, {
							profile: "discovery",
							context: "workloadFacets",
						}),
						"workloadFacets query failed",
					)
					const typedRows = compiled.castRows(rows) as ReadonlyArray<{
						name: string
						count: number
						facetType: string
					}>
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
