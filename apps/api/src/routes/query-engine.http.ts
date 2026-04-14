import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  CurrentTenant,
  ExecuteQueryBuilderResponse,
  MapleApi,
  QueryEngineExecutionError,
  QueryEngineValidationError,
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
import { CH, QueryEngineExecuteRequest } from "@maple/query-engine"
import {
  buildBreakdownQuerySpec,
  buildTimeseriesQuerySpec,
  type QueryBuilderQueryDraft,
} from "@maple/query-engine/query-builder"

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
          const rows = yield* queryEngine.cachedDirect(
            tenant,
            "spanHierarchy",
            payload,
            mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "spanHierarchy query failed"),
          )
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
              errorRate: Number(row.errorRate),
            })),
          })
        }),
      )
      .handle("serviceOverview", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          const compiled = CH.compile(CH.serviceOverviewQuery({ environments: payload.environments, commitShas: payload.commitShas }), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime })
          const rows = yield* queryEngine.cachedDirect(
            tenant,
            "serviceOverview",
            payload,
            mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "serviceOverview query failed"),
          )
          return new ServiceOverviewResponse({ data: rows as any[] })
        }),
      )
      .handle("serviceApdex", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          const compiled = CH.compile(CH.serviceApdexTimeseriesQuery({ serviceName: payload.serviceName, apdexThresholdMs: payload.apdexThresholdMs }), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime, bucketSeconds: payload.bucketSeconds ?? 60 })
          const rows = yield* queryEngine.cachedDirect(
            tenant,
            "serviceApdex",
            payload,
            mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "serviceApdex query failed"),
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
          const rows = yield* queryEngine.cachedDirect(
            tenant,
            "serviceUsage",
            payload,
            mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "serviceUsage query failed"),
          )
          return new ServiceUsageResponse({ data: rows as any[] })
        }),
      )
      .handle("listLogs", ({ payload }) =>
        Effect.gen(function* () {
          const tenant = yield* CurrentTenant.Context
          const compiled = CH.compile(CH.logsListQuery({
            serviceName: payload.service,
            severity: payload.severity,
            minSeverity: payload.minSeverity,
            traceId: payload.traceId,
            spanId: payload.spanId,
            cursor: payload.cursor,
            search: payload.search,
            environments: payload.deploymentEnv ? [payload.deploymentEnv] : undefined,
            matchModes: payload.deploymentEnvMatchMode ? { deploymentEnv: payload.deploymentEnvMatchMode } : undefined,
            limit: payload.limit,
          }), { orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime })
          const rows = yield* queryEngine.cachedDirect(
            tenant,
            "listLogs",
            payload,
            mapExecError(tinybird.sqlQuery(tenant, compiled.sql), "listLogs query failed"),
          )
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
              const built = buildTimeseriesQuerySpec(query as QueryBuilderQueryDraft)
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
          const built = buildBreakdownQuerySpec(primary as QueryBuilderQueryDraft)
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
              data: response.result.data.map((item) => ({ name: item.name, value: item.value })),
            },
            warnings: allWarnings.length > 0 ? allWarnings : undefined,
          })
        }),
      )
  }),
)
