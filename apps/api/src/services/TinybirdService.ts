import { TinybirdQueryError, type TinybirdQueryRequest } from "@maple/domain/http"
import { Tinybird } from "@tinybirdco/sdk"
import { Effect, Redacted } from "effect"
import { Env } from "./Env"
import type { TenantContext } from "./AuthService"
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
  spanAttributeKeys,
  spanAttributeValues,
  spanHierarchy,
  tracesDurationStats,
  tracesFacets,
} from "../tinybird/endpoints"

export class TinybirdService extends Effect.Service<TinybirdService>()("TinybirdService", {
  accessors: true,
  dependencies: [Env.Default],
  effect: Effect.gen(function* () {
    const env = yield* Env

    const client = new Tinybird({
      baseUrl: env.TINYBIRD_HOST,
      token: Redacted.value(env.TINYBIRD_TOKEN),
      datasources: {},
      pipes: {
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
      },
    })

    const toTinybirdQueryError = (pipe: TinybirdQueryRequest["pipe"], error: unknown) =>
      new TinybirdQueryError({
        message: error instanceof Error ? error.message : "Tinybird query failed",
        pipe,
      })

    const runPipe = Effect.fn("TinybirdService.runPipe")(function* <
      TPipe extends TinybirdQueryRequest["pipe"],
      TParams extends Record<string, unknown>,
      TRow,
    >(
      pipe: TPipe,
      tenant: TenantContext,
      params: TParams,
      execute: (params: TParams & { org_id: string }) => Promise<{ data: TRow[] }>,
    ) {
      const result = yield* Effect.tryPromise({
        try: () =>
          execute({
            ...params,
            org_id: tenant.orgId,
          }),
        catch: (error) => toTinybirdQueryError(pipe, error),
      })
      return result.data
    })

    const query = Effect.fn("TinybirdService.query")(function* (
      tenant: TenantContext,
      payload: TinybirdQueryRequest,
    ) {
      const pipeAccessor = (client as unknown as Record<string, { query: (params?: Record<string, unknown>) => Promise<unknown> }>)[
        payload.pipe
      ]
      const queryFunction = pipeAccessor?.query

      if (!queryFunction) {
        return yield* new TinybirdQueryError({
          message: `Unsupported Tinybird pipe: ${payload.pipe}`,
          pipe: payload.pipe,
        })
      }

      const result = (yield* Effect.tryPromise({
        try: () =>
          queryFunction({
            ...(payload.params ?? {}),
            org_id: tenant.orgId,
          }),
        catch: (error) => toTinybirdQueryError(payload.pipe, error),
      })) as { data?: unknown[] }

      return {
        data: result.data ?? [],
      }
    })

    const customTracesTimeseriesQuery = Effect.fn("TinybirdService.customTracesTimeseriesQuery")(function* (
      tenant: TenantContext,
      params: Omit<CustomTracesTimeseriesParams, "org_id">,
    ) {
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
    }
  }),
}) {}
