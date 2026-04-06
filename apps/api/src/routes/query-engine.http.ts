import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  CurrentTenant,
  MapleApi,
  QueryEngineExecutionError,
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
  ServiceUsageResponse,
  ListLogsResponse,
  ListMetricsResponse,
  MetricsSummaryResponse,
} from "@maple/domain/http"
import { Effect } from "effect"
import { QueryEngineService } from "../services/QueryEngineService"
import { TinybirdService } from "../services/TinybirdService"
import { CH } from "@maple/query-engine"

const mapExecError = (effect: Effect.Effect<any, any>, context: string) =>
  effect.pipe(Effect.mapError((cause) => new QueryEngineExecutionError({
    message: context,
    causeTag: cause instanceof Error ? cause.message : String(cause),
  })))

export const HttpQueryEngineLive = HttpApiBuilder.group(MapleApi, "queryEngine", (handlers) =>
  Effect.gen(function* () {
    const queryEngine = yield* QueryEngineService
    const tinybird = yield* TinybirdService

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
          const compiled = CH.compile(CH.spanHierarchyQuery({ traceId: payload.traceId, spanId: payload.spanId }), { orgId: tenant.orgId })
          const rows = yield* mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "spanHierarchy query failed")
          const typedRows = compiled.castRows(rows)
          return new SpanHierarchyResponse({ data: typedRows })
        }),
      )
      .handle("errorsByType", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          const compiled = CH.compile(CH.errorsByTypeQuery({ rootOnly: payload.rootOnly, services: payload.services, deploymentEnvs: payload.deploymentEnvs, errorTypes: payload.errorTypes, limit: payload.limit }), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime })
          const rows = yield* mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "errorsByType query failed")
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
          const compiled = CH.compile(CH.errorsTimeseriesQuery({ errorType: payload.errorType, services: payload.services }), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime, bucketSeconds: payload.bucketSeconds ?? 3600 })
          const rows = yield* mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "errorsTimeseries query failed")
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
          const compiled = CH.compile(CH.errorsSummaryQuery({ rootOnly: payload.rootOnly, services: payload.services, deploymentEnvs: payload.deploymentEnvs, errorTypes: payload.errorTypes }), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime })
          const rows = yield* mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "errorsSummary query failed")
          const typedRows = compiled.castRows(rows)
          return new ErrorsSummaryResponse({
            data: typedRows[0] ? {
              totalErrors: Number(typedRows[0].totalErrors),
              totalSpans: Number(typedRows[0].totalSpans),
              errorRate: Number(typedRows[0].errorRate),
              affectedServicesCount: Number(typedRows[0].affectedServicesCount),
              affectedTracesCount: Number(typedRows[0].affectedTracesCount),
            } : null,
          })
        }),
      )
      .handle("errorDetailTraces", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          const compiled = CH.compile(CH.errorDetailTracesQuery({ errorType: payload.errorType, rootOnly: payload.rootOnly, services: payload.services, limit: payload.limit }), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime })
          const rows = yield* mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "errorDetailTraces query failed")
          const typedRows = compiled.castRows(rows)
          return new ErrorDetailTracesResponse({
            data: typedRows.map((row) => ({
              traceId: row.traceId,
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
          const compiled = CH.compile(CH.errorRateByServiceQuery(), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime })
          const rows = yield* mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "errorRateByService query failed")
          const typedRows = compiled.castRows(rows)
          return new ErrorRateByServiceResponse({
            data: typedRows.map((row) => ({
              serviceName: row.serviceName,
              totalLogs: Number(row.totalLogs),
              errorLogs: Number(row.errorLogs),
              errorRatePercent: Number(row.errorRatePercent),
            })),
          })
        }),
      )
      .handle("serviceOverview", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          const compiled = CH.compile(CH.serviceOverviewQuery({ environments: payload.environments, commitShas: payload.commitShas }), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime })
          const rows = yield* mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "serviceOverview query failed")
          return new ServiceOverviewResponse({ data: rows as any[] })
        }),
      )
      .handle("serviceApdex", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          const compiled = CH.compile(CH.serviceApdexTimeseriesQuery({ serviceName: payload.serviceName, apdexThresholdMs: payload.apdexThresholdMs }), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime, bucketSeconds: payload.bucketSeconds ?? 60 })
          const rows = yield* mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "serviceApdex query failed")
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
          const compiled = CH.compile(CH.serviceReleasesTimelineQuery({ serviceName: payload.serviceName }), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime, bucketSeconds: payload.bucketSeconds ?? 300 })
          const rows = yield* mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "serviceReleases query failed")
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
          const compiled = CH.serviceDependenciesSQL({ deploymentEnv: payload.deploymentEnv }, { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime })
          const rows = yield* mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "serviceDependencies query failed")
          return new ServiceDependenciesResponse({ data: compiled.castRows(rows) as any[] })
        }),
      )
      .handle("serviceUsage", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          const compiled = CH.compile(CH.serviceUsageQuery({ serviceName: payload.service }), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime })
          const rows = yield* mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "serviceUsage query failed")
          return new ServiceUsageResponse({ data: rows as any[] })
        }),
      )
      .handle("listLogs", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          const compiled = CH.compile(CH.logsListQuery({ serviceName: payload.service, severity: payload.severity, minSeverity: payload.minSeverity, traceId: payload.traceId, spanId: payload.spanId, cursor: payload.cursor, search: payload.search, limit: payload.limit }), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime })
          const rows = yield* mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "listLogs query failed")
          return new ListLogsResponse({ data: rows as any[] })
        }),
      )
      .handle("listMetrics", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          const compiled = CH.compileUnion(CH.listMetricsQuery({ serviceName: payload.service, metricType: payload.metricType, search: payload.search, limit: payload.limit, offset: payload.offset }), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime })
          const rows = yield* mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "listMetrics query failed")
          return new ListMetricsResponse({ data: rows as any[] })
        }),
      )
      .handle("metricsSummary", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          const compiled = CH.compileUnion(CH.metricsSummaryQuery({ serviceName: payload.service }), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime })
          const rows = yield* mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "metricsSummary query failed")
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
  }),
)
