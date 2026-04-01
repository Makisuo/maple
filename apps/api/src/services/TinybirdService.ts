import {
  TinybirdQueryError,
  type TinybirdQueryRequest,
  TinybirdQueryResponse,
} from "@maple/domain/http"
import type { OrgId } from "@maple/domain"
import { Tinybird } from "@tinybirdco/sdk"
import { Effect, Layer, Option, Redacted, ServiceMap } from "effect"
import { Env } from "./Env"
import type { TenantContext } from "./AuthService"
import { OrgTinybirdSettingsService } from "./OrgTinybirdSettingsService"

const CLIENT_CACHE_TTL_MS = 30_000
interface CachedClient {
  client: TinybirdClient
  host: string
  token: string
  expiresAt: number
}

export interface TinybirdServiceShape {
  readonly query: (
    tenant: TenantContext,
    payload: TinybirdQueryRequest,
  ) => Effect.Effect<TinybirdQueryResponse, TinybirdQueryError>
  readonly sqlQuery: (
    tenant: TenantContext,
    sql: string,
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, TinybirdQueryError>
  readonly customLogsTimeseriesQuery: (
    tenant: TenantContext,
    params: Omit<CustomLogsTimeseriesParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<CustomLogsTimeseriesOutput>, TinybirdQueryError>
  readonly customLogsBreakdownQuery: (
    tenant: TenantContext,
    params: Omit<CustomLogsBreakdownParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<CustomLogsBreakdownOutput>, TinybirdQueryError>
  readonly alertTracesAggregateQuery: (
    tenant: TenantContext,
    params: Omit<AlertTracesAggregateParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<AlertTracesAggregateOutput>, TinybirdQueryError>
  readonly alertMetricsAggregateQuery: (
    tenant: TenantContext,
    params: Omit<AlertMetricsAggregateParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<AlertMetricsAggregateOutput>, TinybirdQueryError>
  readonly alertLogsAggregateQuery: (
    tenant: TenantContext,
    params: Omit<AlertLogsAggregateParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<AlertLogsAggregateOutput>, TinybirdQueryError>
  readonly alertTracesAggregateByServiceQuery: (
    tenant: TenantContext,
    params: Omit<AlertTracesAggregateByServiceParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<AlertTracesAggregateByServiceOutput>, TinybirdQueryError>
  readonly alertMetricsAggregateByServiceQuery: (
    tenant: TenantContext,
    params: Omit<AlertMetricsAggregateByServiceParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<AlertMetricsAggregateByServiceOutput>, TinybirdQueryError>
  readonly alertLogsAggregateByServiceQuery: (
    tenant: TenantContext,
    params: Omit<AlertLogsAggregateByServiceParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<AlertLogsAggregateByServiceOutput>, TinybirdQueryError>
}
const clientCache = new Map<string, CachedClient>()
import {
  type AlertMetricsAggregateByServiceOutput,
  type AlertMetricsAggregateByServiceParams,
  alertMetricsAggregateByService,
  type AlertMetricsAggregateOutput,
  type AlertMetricsAggregateParams,
  alertMetricsAggregate,
  type AlertLogsAggregateByServiceOutput,
  type AlertLogsAggregateByServiceParams,
  alertLogsAggregateByService,
  type AlertLogsAggregateOutput,
  type AlertLogsAggregateParams,
  alertLogsAggregate,
  type AlertTracesAggregateByServiceOutput,
  type AlertTracesAggregateByServiceParams,
  alertTracesAggregateByService,
  type AlertTracesAggregateOutput,
  type AlertTracesAggregateParams,
  alertTracesAggregate,
  type CustomLogsBreakdownOutput,
  type CustomLogsBreakdownParams,
  type CustomLogsTimeseriesOutput,
  type CustomLogsTimeseriesParams,
  type CustomTracesBreakdownOutput,
  type CustomTracesBreakdownParams,
  type CustomTracesTimeseriesOutput,
  type CustomTracesTimeseriesParams,
  customLogsBreakdown,
  customLogsTimeseries,
  customTracesBreakdown,
  customTracesTimeseries,
  errorDetailTraces,
  errorRateByService,
  errorsByType,
  errorsFacets,
  errorsSummary,
  errorsTimeseries,
  getServiceUsage,
  listLogs,
  listMetrics,
  listTraces,
  logsCount,
  logsFacets,
  metricAttributeKeys,
  metricsSummary,
  serviceApdexTimeSeries,
  serviceDependencies,
  serviceOverview,
  serviceReleasesTimeline,
  servicesFacets,
  resourceAttributeKeys,
  resourceAttributeValues,
  spanAttributeKeys,
  spanAttributeValues,
  spanHierarchy,
  tracesDurationStats,
  tracesFacets,
} from "@maple/domain/tinybird"

const pipes = {
  list_traces: listTraces,
  span_hierarchy: spanHierarchy,
  list_logs: listLogs,
  logs_count: logsCount,
  logs_facets: logsFacets,
  error_rate_by_service: errorRateByService,
  get_service_usage: getServiceUsage,
  list_metrics: listMetrics,
  metrics_summary: metricsSummary,
  traces_facets: tracesFacets,
  traces_duration_stats: tracesDurationStats,
  service_overview: serviceOverview,
  services_facets: servicesFacets,
  service_releases_timeline: serviceReleasesTimeline,
  errors_by_type: errorsByType,
  error_detail_traces: errorDetailTraces,
  errors_facets: errorsFacets,
  errors_summary: errorsSummary,
  errors_timeseries: errorsTimeseries,
  service_apdex_time_series: serviceApdexTimeSeries,
  alert_traces_aggregate: alertTracesAggregate,
  alert_metrics_aggregate: alertMetricsAggregate,
  alert_logs_aggregate: alertLogsAggregate,
  alert_traces_aggregate_by_service: alertTracesAggregateByService,
  alert_metrics_aggregate_by_service: alertMetricsAggregateByService,
  alert_logs_aggregate_by_service: alertLogsAggregateByService,
  custom_traces_timeseries: customTracesTimeseries,
  custom_traces_breakdown: customTracesBreakdown,
  custom_logs_timeseries: customLogsTimeseries,
  custom_logs_breakdown: customLogsBreakdown,
  service_dependencies: serviceDependencies,
  metric_attribute_keys: metricAttributeKeys,
  span_attribute_keys: spanAttributeKeys,
  span_attribute_values: spanAttributeValues,
  resource_attribute_keys: resourceAttributeKeys,
  resource_attribute_values: resourceAttributeValues,
} as const

interface TinybirdPipeQuery<TParams extends Record<string, unknown>, TRow> {
  readonly query: (
    params: TParams & { org_id: OrgId },
  ) => Promise<{ data: ReadonlyArray<TRow> }>
}

interface TinybirdClient {
  readonly custom_traces_timeseries: TinybirdPipeQuery<
    Omit<CustomTracesTimeseriesParams, "org_id">,
    CustomTracesTimeseriesOutput
  >
  readonly custom_traces_breakdown: TinybirdPipeQuery<
    Omit<CustomTracesBreakdownParams, "org_id">,
    CustomTracesBreakdownOutput
  >
  readonly custom_logs_timeseries: TinybirdPipeQuery<
    Omit<CustomLogsTimeseriesParams, "org_id">,
    CustomLogsTimeseriesOutput
  >
  readonly custom_logs_breakdown: TinybirdPipeQuery<
    Omit<CustomLogsBreakdownParams, "org_id">,
    CustomLogsBreakdownOutput
  >
  readonly alert_traces_aggregate: TinybirdPipeQuery<
    Omit<AlertTracesAggregateParams, "org_id">,
    AlertTracesAggregateOutput
  >
  readonly alert_metrics_aggregate: TinybirdPipeQuery<
    Omit<AlertMetricsAggregateParams, "org_id">,
    AlertMetricsAggregateOutput
  >
  readonly alert_logs_aggregate: TinybirdPipeQuery<
    Omit<AlertLogsAggregateParams, "org_id">,
    AlertLogsAggregateOutput
  >
  readonly alert_traces_aggregate_by_service: TinybirdPipeQuery<
    Omit<AlertTracesAggregateByServiceParams, "org_id">,
    AlertTracesAggregateByServiceOutput
  >
  readonly alert_metrics_aggregate_by_service: TinybirdPipeQuery<
    Omit<AlertMetricsAggregateByServiceParams, "org_id">,
    AlertMetricsAggregateByServiceOutput
  >
  readonly alert_logs_aggregate_by_service: TinybirdPipeQuery<
    Omit<AlertLogsAggregateByServiceParams, "org_id">,
    AlertLogsAggregateByServiceOutput
  >
}

const createClient = (baseUrl: string, token: string): TinybirdClient =>
  new Tinybird({
    baseUrl,
    token,
    datasources: {},
    pipes,
  }) as unknown as TinybirdClient

let tinybirdClientFactory: typeof createClient = createClient

export class TinybirdService extends ServiceMap.Service<TinybirdService, TinybirdServiceShape>()("TinybirdService", {
  make: Effect.gen(function* () {
    const env = yield* Env
    const orgTinybirdSettings = yield* OrgTinybirdSettingsService

    const toTinybirdQueryError = (pipe: TinybirdQueryRequest["pipe"], error: unknown) =>
      new TinybirdQueryError({
        message: error instanceof Error ? error.message : "Tinybird query failed",
        pipe,
      })

    const getCachedOrCreateClient = (orgId: string, host: string, token: string) => {
      const now = Date.now()
      const cached = clientCache.get(orgId)
      if (cached && cached.host === host && cached.token === token && cached.expiresAt > now) {
        return cached.client
      }
      const client = tinybirdClientFactory(host, token)
      clientCache.set(orgId, { client, host, token, expiresAt: now + CLIENT_CACHE_TTL_MS })
      return client
    }

      const resolveClient = Effect.fn("TinybirdService.resolveClient")(function* (
        tenant: TenantContext,
        pipe: TinybirdQueryRequest["pipe"],
      ) {
      const override = yield* orgTinybirdSettings
        .resolveRuntimeConfig(tenant.orgId)
        .pipe(Effect.mapError((error) => toTinybirdQueryError(pipe, error)))

      if (Option.isSome(override)) {
        return getCachedOrCreateClient(tenant.orgId, override.value.host, override.value.token)
      }

      return getCachedOrCreateClient("__managed__", env.TINYBIRD_HOST, Redacted.value(env.TINYBIRD_TOKEN))
    })

    const runPipe = Effect.fn("TinybirdService.runPipe")(function* <
      TPipe extends TinybirdQueryRequest["pipe"],
      TParams extends Record<string, unknown>,
      TRow,
    >(
      pipe: TPipe,
      tenant: TenantContext,
      params: TParams,
      execute: (
        params: TParams & { org_id: OrgId },
      ) => PromiseLike<{ data: ReadonlyArray<TRow> }>,
    ) {
      if (!tenant.orgId || tenant.orgId.trim() === "") {
        return yield* new TinybirdQueryError({ pipe, message: "org_id must not be empty" })
      }
      const result = yield* Effect.tryPromise({
        try: async (_signal) =>
          execute({
            ...params,
            org_id: tenant.orgId,
          }),
        catch: (error) => toTinybirdQueryError(pipe, error),
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError("TinybirdService.runPipe failed", { pipe, error: String(error) })
        )
      )
      return result.data as ReadonlyArray<TRow>
    })

    const query = Effect.fn("TinybirdService.query")(function* (
      tenant: TenantContext,
      payload: TinybirdQueryRequest,
    ) {
      if (!tenant.orgId || tenant.orgId.trim() === "") {
        return yield* new TinybirdQueryError({ pipe: payload.pipe, message: "org_id must not be empty" })
      }
      const client = yield* resolveClient(tenant, payload.pipe)
      const pipeAccessor = (
        client as unknown as Record<
          string,
          {
            readonly query: (
              params?: Record<string, unknown>,
            ) => Promise<{ data?: ReadonlyArray<unknown> }>
          }
        >
      )[payload.pipe]
      const queryFunction = pipeAccessor?.query

      if (!queryFunction) {
        return yield* new TinybirdQueryError({
          message: `Unsupported Tinybird pipe: ${payload.pipe}`,
          pipe: payload.pipe,
        })
      }

      const result = yield* Effect.tryPromise({
        try: async (_signal) =>
          queryFunction({
            ...(payload.params ?? {}),
            org_id: tenant.orgId,
          }),
        catch: (error) => toTinybirdQueryError(payload.pipe, error),
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError("TinybirdService.query failed", { pipe: payload.pipe, error: String(error) })
        )
      )

      return new TinybirdQueryResponse({
        data: Array.from(result.data ?? []),
      })
    })

    const customLogsTimeseriesQuery = Effect.fn("TinybirdService.customLogsTimeseriesQuery")(function* (
      tenant: TenantContext,
      params: Omit<CustomLogsTimeseriesParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "custom_logs_timeseries")
      return yield* runPipe<
        "custom_logs_timeseries",
        Omit<CustomLogsTimeseriesParams, "org_id">,
        CustomLogsTimeseriesOutput
      >("custom_logs_timeseries", tenant, params, client.custom_logs_timeseries.query)
    })

    const customLogsBreakdownQuery = Effect.fn("TinybirdService.customLogsBreakdownQuery")(function* (
      tenant: TenantContext,
      params: Omit<CustomLogsBreakdownParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "custom_logs_breakdown")
      return yield* runPipe<
        "custom_logs_breakdown",
        Omit<CustomLogsBreakdownParams, "org_id">,
        CustomLogsBreakdownOutput
      >("custom_logs_breakdown", tenant, params, client.custom_logs_breakdown.query)
    })

    const alertTracesAggregateQuery = Effect.fn("TinybirdService.alertTracesAggregateQuery")(function* (
      tenant: TenantContext,
      params: Omit<AlertTracesAggregateParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "alert_traces_aggregate")
      return yield* runPipe<
        "alert_traces_aggregate",
        Omit<AlertTracesAggregateParams, "org_id">,
        AlertTracesAggregateOutput
      >("alert_traces_aggregate", tenant, params, client.alert_traces_aggregate.query)
    })

    const alertMetricsAggregateQuery = Effect.fn("TinybirdService.alertMetricsAggregateQuery")(function* (
      tenant: TenantContext,
      params: Omit<AlertMetricsAggregateParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "alert_metrics_aggregate")
      return yield* runPipe<
        "alert_metrics_aggregate",
        Omit<AlertMetricsAggregateParams, "org_id">,
        AlertMetricsAggregateOutput
      >("alert_metrics_aggregate", tenant, params, client.alert_metrics_aggregate.query)
    })

    const alertLogsAggregateQuery = Effect.fn("TinybirdService.alertLogsAggregateQuery")(function* (
      tenant: TenantContext,
      params: Omit<AlertLogsAggregateParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "alert_logs_aggregate")
      return yield* runPipe<
        "alert_logs_aggregate",
        Omit<AlertLogsAggregateParams, "org_id">,
        AlertLogsAggregateOutput
      >("alert_logs_aggregate", tenant, params, client.alert_logs_aggregate.query)
    })

    const alertTracesAggregateByServiceQuery = Effect.fn("TinybirdService.alertTracesAggregateByServiceQuery")(function* (
      tenant: TenantContext,
      params: Omit<AlertTracesAggregateByServiceParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "alert_traces_aggregate_by_service")
      return yield* runPipe<
        "alert_traces_aggregate_by_service",
        Omit<AlertTracesAggregateByServiceParams, "org_id">,
        AlertTracesAggregateByServiceOutput
      >("alert_traces_aggregate_by_service", tenant, params, client.alert_traces_aggregate_by_service.query)
    })

    const alertMetricsAggregateByServiceQuery = Effect.fn("TinybirdService.alertMetricsAggregateByServiceQuery")(function* (
      tenant: TenantContext,
      params: Omit<AlertMetricsAggregateByServiceParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "alert_metrics_aggregate_by_service")
      return yield* runPipe<
        "alert_metrics_aggregate_by_service",
        Omit<AlertMetricsAggregateByServiceParams, "org_id">,
        AlertMetricsAggregateByServiceOutput
      >("alert_metrics_aggregate_by_service", tenant, params, client.alert_metrics_aggregate_by_service.query)
    })

    const alertLogsAggregateByServiceQuery = Effect.fn("TinybirdService.alertLogsAggregateByServiceQuery")(function* (
      tenant: TenantContext,
      params: Omit<AlertLogsAggregateByServiceParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "alert_logs_aggregate_by_service")
      return yield* runPipe<
        "alert_logs_aggregate_by_service",
        Omit<AlertLogsAggregateByServiceParams, "org_id">,
        AlertLogsAggregateByServiceOutput
      >("alert_logs_aggregate_by_service", tenant, params, client.alert_logs_aggregate_by_service.query)
    })

    const sqlQuery = Effect.fn("TinybirdService.sqlQuery")(function* (
      tenant: TenantContext,
      sql: string,
    ) {
      if (!tenant.orgId || tenant.orgId.trim() === "") {
        return yield* new TinybirdQueryError({ pipe: "custom_traces_timeseries", message: "org_id must not be empty" })
      }
      if (!sql.includes("OrgId")) {
        return yield* new TinybirdQueryError({ pipe: "custom_traces_timeseries", message: "SQL query must contain OrgId filter" })
      }
      // Use "custom_traces_timeseries" as the pipe identifier for client resolution / error context
      const client = yield* resolveClient(tenant, "custom_traces_timeseries")
      const result = yield* Effect.tryPromise({
        try: () => (client as unknown as { sql: (sql: string) => Promise<{ data: ReadonlyArray<Record<string, unknown>> }> }).sql(sql),
        catch: (error) => toTinybirdQueryError("custom_traces_timeseries", error),
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError("TinybirdService.sqlQuery failed", { error: String(error) })
        ),
      )
      return result.data
    })

    return {
      query,
      sqlQuery,
      customLogsTimeseriesQuery,
      customLogsBreakdownQuery,
      alertTracesAggregateQuery,
      alertMetricsAggregateQuery,
      alertLogsAggregateQuery,
      alertTracesAggregateByServiceQuery,
      alertMetricsAggregateByServiceQuery,
      alertLogsAggregateByServiceQuery,
    } satisfies TinybirdServiceShape
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
  static readonly Live = this.layer
  static readonly Default = this.layer

  static readonly query = (
    tenant: TenantContext,
    payload: TinybirdQueryRequest,
  ) => this.use((service) => service.query(tenant, payload))
}

export const __testables = {
  setClientFactory: (factory: typeof createClient) => {
    tinybirdClientFactory = factory
    clientCache.clear()
  },
  reset: () => {
    tinybirdClientFactory = createClient
    clientCache.clear()
  },
}
