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
  readonly customTracesTimeseriesQuery: (
    tenant: TenantContext,
    params: Omit<CustomTracesTimeseriesParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<CustomTracesTimeseriesOutput>, TinybirdQueryError>
  readonly customTracesBreakdownQuery: (
    tenant: TenantContext,
    params: Omit<CustomTracesBreakdownParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<CustomTracesBreakdownOutput>, TinybirdQueryError>
  readonly customLogsTimeseriesQuery: (
    tenant: TenantContext,
    params: Omit<CustomLogsTimeseriesParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<CustomLogsTimeseriesOutput>, TinybirdQueryError>
  readonly customLogsBreakdownQuery: (
    tenant: TenantContext,
    params: Omit<CustomLogsBreakdownParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<CustomLogsBreakdownOutput>, TinybirdQueryError>
  readonly customMetricsBreakdownQuery: (
    tenant: TenantContext,
    params: Omit<CustomMetricsBreakdownParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<CustomMetricsBreakdownOutput>, TinybirdQueryError>
  readonly metricTimeSeriesSumQuery: (
    tenant: TenantContext,
    params: Omit<MetricTimeSeriesSumParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<MetricTimeSeriesSumOutput>, TinybirdQueryError>
  readonly metricTimeSeriesGaugeQuery: (
    tenant: TenantContext,
    params: Omit<MetricTimeSeriesGaugeParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<MetricTimeSeriesGaugeOutput>, TinybirdQueryError>
  readonly metricTimeSeriesHistogramQuery: (
    tenant: TenantContext,
    params: Omit<MetricTimeSeriesHistogramParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<MetricTimeSeriesHistogramOutput>, TinybirdQueryError>
  readonly metricTimeSeriesExpHistogramQuery: (
    tenant: TenantContext,
    params: Omit<MetricTimeSeriesExpHistogramParams, "org_id">,
  ) => Effect.Effect<ReadonlyArray<MetricTimeSeriesExpHistogramOutput>, TinybirdQueryError>
}
const clientCache = new Map<string, CachedClient>()
import {
  type CustomLogsBreakdownOutput,
  type CustomLogsBreakdownParams,
  type CustomLogsTimeseriesOutput,
  type CustomLogsTimeseriesParams,
  type CustomMetricsBreakdownOutput,
  type CustomMetricsBreakdownParams,
  type CustomTracesBreakdownOutput,
  type CustomTracesBreakdownParams,
  type CustomTracesTimeseriesOutput,
  type CustomTracesTimeseriesParams,
  customLogsBreakdown,
  customLogsTimeseries,
  customMetricsBreakdown,
  customTracesBreakdown,
  customTracesTimeseries,
  errorDetailTraces,
  errorRateByService,
  errorsByType,
  errorsFacets,
  errorsSummary,
  getServiceUsage,
  listLogs,
  listMetrics,
  listTraces,
  logsCount,
  logsFacets,
  type MetricTimeSeriesExpHistogramOutput,
  type MetricTimeSeriesExpHistogramParams,
  metricTimeSeriesExpHistogram,
  type MetricTimeSeriesGaugeOutput,
  type MetricTimeSeriesGaugeParams,
  metricTimeSeriesGauge,
  type MetricTimeSeriesHistogramOutput,
  type MetricTimeSeriesHistogramParams,
  metricTimeSeriesHistogram,
  type MetricTimeSeriesSumOutput,
  type MetricTimeSeriesSumParams,
  metricTimeSeriesSum,
  metricsSummary,
  serviceApdexTimeSeries,
  serviceDependencies,
  serviceOverview,
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
  metric_time_series_sum: metricTimeSeriesSum,
  metric_time_series_gauge: metricTimeSeriesGauge,
  metric_time_series_histogram: metricTimeSeriesHistogram,
  metric_time_series_exp_histogram: metricTimeSeriesExpHistogram,
  metrics_summary: metricsSummary,
  traces_facets: tracesFacets,
  traces_duration_stats: tracesDurationStats,
  service_overview: serviceOverview,
  services_facets: servicesFacets,
  errors_by_type: errorsByType,
  error_detail_traces: errorDetailTraces,
  errors_facets: errorsFacets,
  errors_summary: errorsSummary,
  service_apdex_time_series: serviceApdexTimeSeries,
  custom_traces_timeseries: customTracesTimeseries,
  custom_traces_breakdown: customTracesBreakdown,
  custom_logs_timeseries: customLogsTimeseries,
  custom_logs_breakdown: customLogsBreakdown,
  custom_metrics_breakdown: customMetricsBreakdown,
  service_dependencies: serviceDependencies,
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
  readonly custom_metrics_breakdown: TinybirdPipeQuery<
    Omit<CustomMetricsBreakdownParams, "org_id">,
    CustomMetricsBreakdownOutput
  >
  readonly metric_time_series_sum: TinybirdPipeQuery<
    Omit<MetricTimeSeriesSumParams, "org_id">,
    MetricTimeSeriesSumOutput
  >
  readonly metric_time_series_gauge: TinybirdPipeQuery<
    Omit<MetricTimeSeriesGaugeParams, "org_id">,
    MetricTimeSeriesGaugeOutput
  >
  readonly metric_time_series_histogram: TinybirdPipeQuery<
    Omit<MetricTimeSeriesHistogramParams, "org_id">,
    MetricTimeSeriesHistogramOutput
  >
  readonly metric_time_series_exp_histogram: TinybirdPipeQuery<
    Omit<MetricTimeSeriesExpHistogramParams, "org_id">,
    MetricTimeSeriesExpHistogramOutput
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
      const result = yield* Effect.tryPromise({
        try: async (_signal) =>
          execute({
            ...params,
            org_id: tenant.orgId,
          }),
        catch: (error) => toTinybirdQueryError(pipe, error),
      })
      return result.data as ReadonlyArray<TRow>
    })

    const query = Effect.fn("TinybirdService.query")(function* (
      tenant: TenantContext,
      payload: TinybirdQueryRequest,
    ) {
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
      })

      return new TinybirdQueryResponse({
        data: Array.from(result.data ?? []),
      })
    })

    const customTracesTimeseriesQuery = Effect.fn("TinybirdService.customTracesTimeseriesQuery")(function* (
      tenant: TenantContext,
      params: Omit<CustomTracesTimeseriesParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "custom_traces_timeseries")
      return yield* runPipe<
        "custom_traces_timeseries",
        Omit<CustomTracesTimeseriesParams, "org_id">,
        CustomTracesTimeseriesOutput
      >("custom_traces_timeseries", tenant, params, client.custom_traces_timeseries.query)
    })

    const customTracesBreakdownQuery = Effect.fn("TinybirdService.customTracesBreakdownQuery")(function* (
      tenant: TenantContext,
      params: Omit<CustomTracesBreakdownParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "custom_traces_breakdown")
      return yield* runPipe<
        "custom_traces_breakdown",
        Omit<CustomTracesBreakdownParams, "org_id">,
        CustomTracesBreakdownOutput
      >("custom_traces_breakdown", tenant, params, client.custom_traces_breakdown.query)
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

    const customMetricsBreakdownQuery = Effect.fn("TinybirdService.customMetricsBreakdownQuery")(function* (
      tenant: TenantContext,
      params: Omit<CustomMetricsBreakdownParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "custom_metrics_breakdown")
      return yield* runPipe<
        "custom_metrics_breakdown",
        Omit<CustomMetricsBreakdownParams, "org_id">,
        CustomMetricsBreakdownOutput
      >("custom_metrics_breakdown", tenant, params, client.custom_metrics_breakdown.query)
    })

    const metricTimeSeriesSumQuery = Effect.fn("TinybirdService.metricTimeSeriesSumQuery")(function* (
      tenant: TenantContext,
      params: Omit<MetricTimeSeriesSumParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "metric_time_series_sum")
      return yield* runPipe<
        "metric_time_series_sum",
        Omit<MetricTimeSeriesSumParams, "org_id">,
        MetricTimeSeriesSumOutput
      >("metric_time_series_sum", tenant, params, client.metric_time_series_sum.query)
    })

    const metricTimeSeriesGaugeQuery = Effect.fn("TinybirdService.metricTimeSeriesGaugeQuery")(function* (
      tenant: TenantContext,
      params: Omit<MetricTimeSeriesGaugeParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "metric_time_series_gauge")
      return yield* runPipe<
        "metric_time_series_gauge",
        Omit<MetricTimeSeriesGaugeParams, "org_id">,
        MetricTimeSeriesGaugeOutput
      >("metric_time_series_gauge", tenant, params, client.metric_time_series_gauge.query)
    })

    const metricTimeSeriesHistogramQuery = Effect.fn(
      "TinybirdService.metricTimeSeriesHistogramQuery",
    )(function* (
      tenant: TenantContext,
      params: Omit<MetricTimeSeriesHistogramParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "metric_time_series_histogram")
      return yield* runPipe<
        "metric_time_series_histogram",
        Omit<MetricTimeSeriesHistogramParams, "org_id">,
        MetricTimeSeriesHistogramOutput
      >("metric_time_series_histogram", tenant, params, client.metric_time_series_histogram.query)
    })

    const metricTimeSeriesExpHistogramQuery = Effect.fn(
      "TinybirdService.metricTimeSeriesExpHistogramQuery",
    )(function* (
      tenant: TenantContext,
      params: Omit<MetricTimeSeriesExpHistogramParams, "org_id">,
    ) {
      const client = yield* resolveClient(tenant, "metric_time_series_exp_histogram")
      return yield* runPipe<
        "metric_time_series_exp_histogram",
        Omit<MetricTimeSeriesExpHistogramParams, "org_id">,
        MetricTimeSeriesExpHistogramOutput
      >(
        "metric_time_series_exp_histogram",
        tenant,
        params,
        client.metric_time_series_exp_histogram.query,
      )
    })

    return {
      query,
      customTracesTimeseriesQuery,
      customTracesBreakdownQuery,
      customLogsTimeseriesQuery,
      customLogsBreakdownQuery,
      customMetricsBreakdownQuery,
      metricTimeSeriesSumQuery,
      metricTimeSeriesGaugeQuery,
      metricTimeSeriesHistogramQuery,
      metricTimeSeriesExpHistogramQuery,
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
