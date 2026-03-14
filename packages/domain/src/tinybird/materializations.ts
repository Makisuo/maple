import { defineMaterializedView, node } from "@tinybirdco/sdk";
import {
  serviceUsage,
  serviceMapSpans,
  serviceOverviewSpans,
} from "./datasources";

/**
 * Materialized view to aggregate log usage statistics per service per hour
 */
export const serviceUsageLogsMv = defineMaterializedView(
  "service_usage_logs_mv",
  {
    description:
      "Materialized view to aggregate log usage statistics per service per hour",
    datasource: serviceUsage,
    nodes: [
      node({
        name: "service_usage_logs_mv_node",
        sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(TimestampTime) AS Hour,
          count() AS LogCount,
          sum(length(Body) + 200) AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM logs
        GROUP BY OrgId, ServiceName, Hour
      `,
      }),
    ],
  }
);

/**
 * Materialized view to aggregate trace/span usage statistics per service per hour
 */
export const serviceUsageTracesMv = defineMaterializedView(
  "service_usage_traces_mv",
  {
    description:
      "Materialized view to aggregate trace/span usage statistics per service per hour",
    datasource: serviceUsage,
    nodes: [
      node({
        name: "service_usage_traces_mv_node",
        sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          count() AS TraceCount,
          sum(length(SpanName) + 300) AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM traces
        GROUP BY OrgId, ServiceName, Hour
      `,
      }),
    ],
  }
);

/**
 * Materialized view to aggregate sum metric usage statistics per service per hour
 */
export const serviceUsageMetricsSumMv = defineMaterializedView(
  "service_usage_metrics_sum_mv",
  {
    description:
      "Materialized view to aggregate sum metric usage statistics per service per hour",
    datasource: serviceUsage,
    nodes: [
      node({
        name: "service_usage_metrics_sum_mv_node",
        sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          count() AS SumMetricCount,
          count() * 150 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM metrics_sum
        GROUP BY OrgId, ServiceName, Hour
      `,
      }),
    ],
  }
);

/**
 * Materialized view to aggregate gauge metric usage statistics per service per hour
 */
export const serviceUsageMetricsGaugeMv = defineMaterializedView(
  "service_usage_metrics_gauge_mv",
  {
    description:
      "Materialized view to aggregate gauge metric usage statistics per service per hour",
    datasource: serviceUsage,
    nodes: [
      node({
        name: "service_usage_metrics_gauge_mv_node",
        sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          count() AS GaugeMetricCount,
          count() * 150 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM metrics_gauge
        GROUP BY OrgId, ServiceName, Hour
      `,
      }),
    ],
  }
);

/**
 * Materialized view to aggregate histogram metric usage statistics per service per hour
 */
export const serviceUsageMetricsHistogramMv = defineMaterializedView(
  "service_usage_metrics_histogram_mv",
  {
    description:
      "Materialized view to aggregate histogram metric usage statistics per service per hour",
    datasource: serviceUsage,
    nodes: [
      node({
        name: "service_usage_metrics_histogram_mv_node",
        sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          count() AS HistogramMetricCount,
          count() * 250 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM metrics_histogram
        GROUP BY OrgId, ServiceName, Hour
      `,
      }),
    ],
  }
);

/**
 * Materialized view to aggregate exponential histogram metric usage statistics per service per hour
 */
export const serviceUsageMetricsExpHistogramMv = defineMaterializedView(
  "service_usage_metrics_exp_histogram_mv",
  {
    description:
      "Materialized view to aggregate exponential histogram metric usage statistics per service per hour",
    datasource: serviceUsage,
    nodes: [
      node({
        name: "service_usage_metrics_exp_histogram_mv_node",
        sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          count() AS ExpHistogramMetricCount,
          count() * 300 AS ExpHistogramMetricSizeBytes
        FROM metrics_exponential_histogram
        GROUP BY OrgId, ServiceName, Hour
      `,
      }),
    ],
  }
);

/**
 * Materialized view projecting trace spans needed for service dependency map.
 * Extracts peer.service and deployment.environment from Map columns at write time
 * so the service map JOIN query avoids scanning heavy Map columns.
 */
export const serviceMapSpansMv = defineMaterializedView(
  "service_map_spans_mv",
  {
    description:
      "Materialized view projecting trace spans needed for service dependency map. Extracts peer.service and deployment.environment from Map columns at write time.",
    datasource: serviceMapSpans,
    nodes: [
      node({
        name: "service_map_spans_mv_node",
        sql: `
        SELECT
          OrgId,
          toDateTime(Timestamp) AS Timestamp,
          TraceId,
          SpanId,
          ParentSpanId,
          ServiceName,
          SpanKind,
          Duration,
          StatusCode,
          TraceState,
          SpanAttributes['peer.service'] AS PeerService,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv
        FROM traces
        WHERE SpanKind IN ('Client', 'Producer', 'Server', 'Consumer')
      `,
      }),
    ],
  }
);

/**
 * Materialized view projecting root spans for service overview queries.
 * Pre-extracts deployment.environment and deployment.commit_sha from ResourceAttributes
 * so the service overview query avoids scanning heavy Map columns.
 */
export const serviceOverviewSpansMv = defineMaterializedView(
  "service_overview_spans_mv",
  {
    description:
      "Materialized view projecting root spans for service overview queries. Pre-extracts deployment attributes from ResourceAttributes at write time.",
    datasource: serviceOverviewSpans,
    nodes: [
      node({
        name: "service_overview_spans_mv_node",
        sql: `
        SELECT
          OrgId,
          toDateTime(Timestamp) AS Timestamp,
          ServiceName,
          Duration,
          StatusCode,
          TraceState,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv,
          ResourceAttributes['deployment.commit_sha'] AS CommitSha
        FROM traces
        WHERE ParentSpanId = ''
      `,
      }),
    ],
  }
);
