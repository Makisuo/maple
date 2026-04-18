import { defineMaterializedView, node } from "@tinybirdco/sdk";
import {
  serviceUsage,
  serviceMapSpans,
  serviceMapChildren,
  serviceMapEdgesHourly,
  serviceOverviewSpans,
  errorSpans,
  errorEvents,
  traceDetailSpans,
  traceListMv,
  attributeKeysHourly,
  attributeValuesHourly,
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
 * Materialized view projecting service entry point spans for service overview queries.
 * Includes Server/Consumer spans (service entry points per OTel semantics) plus root spans
 * as a fallback for services with Internal/unset SpanKind (cron jobs, workers).
 * Pre-extracts deployment.environment and deployment.commit_sha from ResourceAttributes
 * so the service overview query avoids scanning heavy Map columns.
 */
export const serviceOverviewSpansMv = defineMaterializedView(
  "service_overview_spans_mv",
  {
    description:
      "Materialized view projecting service entry point spans (Server/Consumer + root) for service overview queries. Pre-extracts deployment attributes from ResourceAttributes at write time.",
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
        WHERE SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''
      `,
      }),
    ],
  }
);

/**
 * Materialized view populating trace_list_mv from root spans.
 * Pre-extracts HTTP attributes from SpanAttributes and normalizes span names
 * so the trace list query avoids scanning heavy Map columns and GROUP BY.
 */
/**
 * Materialized view populating service_map_children from Server/Consumer spans.
 * Pre-filters to only spans with a parent and extracts deployment.environment
 * so the service map JOIN query scans far fewer rows on the child side.
 */
export const serviceMapChildrenMv = defineMaterializedView(
  "service_map_children_mv",
  {
    description:
      "Populates service_map_children with Server/Consumer spans that have a parent for efficient JOIN lookups.",
    datasource: serviceMapChildren,
    nodes: [
      node({
        name: "service_map_children_mv_node",
        sql: `
        SELECT
          OrgId,
          toDateTime(Timestamp) AS Timestamp,
          TraceId,
          ParentSpanId,
          ServiceName,
          SpanKind,
          Duration,
          StatusCode,
          TraceState,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv
        FROM traces
        WHERE SpanKind IN ('Server', 'Consumer')
          AND ParentSpanId != ''
      `,
      }),
    ],
  }
);

/**
 * Materialized view pre-aggregating service-to-service edges per hour.
 * Aggregates Client spans with peer.service into hourly buckets at write time
 * so the service map query scans pre-aggregated rows instead of individual spans.
 */
export const serviceMapEdgesHourlyMv = defineMaterializedView(
  "service_map_edges_hourly_mv",
  {
    description:
      "Pre-aggregates Client spans with peer.service into hourly service-to-service edge buckets for fast service map queries.",
    datasource: serviceMapEdgesHourly,
    nodes: [
      node({
        name: "service_map_edges_hourly_mv_node",
        sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          ServiceName AS SourceService,
          SpanAttributes['peer.service'] AS TargetService,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv,
          count() AS CallCount,
          countIf(StatusCode = 'Error') AS ErrorCount,
          sum(Duration / 1000000) AS DurationSumMs,
          max(Duration / 1000000) AS MaxDurationMs,
          countIf(TraceState LIKE '%th:%') AS SampledSpanCount,
          countIf(TraceState = '' OR TraceState NOT LIKE '%th:%') AS UnsampledSpanCount
        FROM traces
        WHERE SpanKind = 'Client'
          AND SpanAttributes['peer.service'] != ''
        GROUP BY OrgId, Hour, SourceService, TargetService, DeploymentEnv
      `,
      }),
    ],
  }
);

/**
 * Materialized view populating error_spans from error spans.
 * Pre-filters to StatusCode='Error' and pre-extracts deployment.environment
 * so error queries avoid scanning the full traces table and Map columns.
 */
export const errorSpansMv = defineMaterializedView("error_spans_mv", {
  description:
    "Materializes error spans from traces. Pre-filters to StatusCode='Error' and pre-extracts deployment.environment.",
  datasource: errorSpans,
  nodes: [
    node({
      name: "error_spans_mv_node",
      sql: `
        SELECT
          OrgId,
          toDateTime(Timestamp) AS Timestamp,
          TraceId,
          SpanId,
          ParentSpanId,
          ServiceName,
          StatusMessage,
          Duration,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv
        FROM traces
        WHERE StatusCode = 'Error'
      `,
    }),
  ],
});

/**
 * Materialized view populating error_events from traces where StatusCode='Error'.
 * Unwraps the first OTel `exception` event in EventsAttributes to surface
 * exception.type / exception.message / exception.stacktrace as flat columns,
 * normalizes the top stack frame, and computes a cityHash64 fingerprint used
 * to group occurrences into Issues. Falls back to StatusMessage when no
 * exception event is present (legacy / non-semantic spans).
 */
export const errorEventsMv = defineMaterializedView("error_events_mv", {
  description:
    "Materializes per-occurrence error events from traces. Unwraps the first OTel exception event and computes a cityHash64 FingerprintHash for issue grouping.",
  datasource: errorEvents,
  nodes: [
    node({
      name: "error_events_mv_node",
      sql: `
        WITH
          arrayFirstIndex(n -> n = 'exception', EventsName) AS _ei,
          if(_ei > 0, EventsAttributes[_ei]['exception.type'], '') AS _exType,
          if(_ei > 0, EventsAttributes[_ei]['exception.message'], StatusMessage) AS _exMsg,
          if(_ei > 0, EventsAttributes[_ei]['exception.stacktrace'], '') AS _exStack,
          replaceRegexpAll(
            splitByChar('\\n', _exStack)[1],
            ':[0-9]+|0x[0-9a-fA-F]+',
            ''
          ) AS _topFrame
        SELECT
          OrgId,
          toDateTime(Timestamp) AS Timestamp,
          TraceId,
          SpanId,
          ParentSpanId,
          ServiceName,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv,
          _exType AS ExceptionType,
          _exMsg AS ExceptionMessage,
          _exStack AS ExceptionStacktrace,
          _topFrame AS TopFrame,
          cityHash64(OrgId, ServiceName, _exType, _topFrame) AS FingerprintHash,
          StatusMessage,
          Duration
        FROM traces
        WHERE StatusCode = 'Error'
      `,
    }),
  ],
});

export const traceDetailSpansMv = defineMaterializedView(
  "trace_detail_spans_mv",
  {
    description:
      "Populates trace_detail_spans with all spans re-sorted by TraceId for fast detail lookups",
    datasource: traceDetailSpans,
    nodes: [
      node({
        name: "trace_detail_spans_mv_node",
        sql: `
        SELECT
          OrgId,
          Timestamp,
          TraceId,
          SpanId,
          ParentSpanId,
          SpanName,
          SpanKind,
          ServiceName,
          Duration,
          StatusCode,
          StatusMessage,
          SpanAttributes,
          ResourceAttributes,
          EventsTimestamp,
          EventsName,
          EventsAttributes
        FROM traces
      `,
      }),
    ],
  }
);

export const traceListMvMv = defineMaterializedView("trace_list_mv_mv", {
  description:
    "Populates trace_list_mv from root spans with pre-extracted HTTP attributes and normalized span names.",
  datasource: traceListMv,
  nodes: [
    node({
      name: "trace_list_mv_node",
      sql: `
        SELECT
          OrgId,
          TraceId,
          toDateTime(Timestamp) AS Timestamp,
          ServiceName,
          if(
            (SpanName LIKE 'http.server %' OR SpanName IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'))
            AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != ''),
            concat(
              if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName),
              ' ',
              if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])
            ),
            SpanName
          ) AS SpanName,
          SpanKind,
          Duration,
          StatusCode,
          if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) AS HttpMethod,
          if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], if(SpanAttributes['url.path'] != '', SpanAttributes['url.path'], SpanAttributes['http.target'])) AS HttpRoute,
          if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) AS HttpStatusCode,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv,
          toUInt8(
            StatusCode = 'Error'
            OR (SpanAttributes['http.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.status_code']) >= 500)
            OR (SpanAttributes['http.response.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.response.status_code']) >= 500)
          ) AS HasError,
          TraceState
        FROM traces
        WHERE ParentSpanId = ''
      `,
    }),
  ],
});

// ---------------------------------------------------------------------------
// Attribute key aggregation MVs
// ---------------------------------------------------------------------------

export const traceSpanAttributeKeysMv = defineMaterializedView(
  "trace_span_attribute_keys_mv",
  {
    description: "Aggregates span attribute keys from traces hourly.",
    datasource: attributeKeysHourly,
    nodes: [
      node({
        name: "trace_span_attribute_keys_mv_node",
        sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          arrayJoin(mapKeys(SpanAttributes)) AS AttributeKey,
          'span' AS AttributeScope,
          count() AS UsageCount
        FROM traces
        WHERE SpanAttributes != map()
        GROUP BY OrgId, Hour, AttributeKey, AttributeScope
      `,
      }),
    ],
  },
);

export const traceResourceAttributeKeysMv = defineMaterializedView(
  "trace_resource_attribute_keys_mv",
  {
    description: "Aggregates resource attribute keys from traces hourly.",
    datasource: attributeKeysHourly,
    nodes: [
      node({
        name: "trace_resource_attribute_keys_mv_node",
        sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          arrayJoin(mapKeys(ResourceAttributes)) AS AttributeKey,
          'resource' AS AttributeScope,
          count() AS UsageCount
        FROM traces
        WHERE ResourceAttributes != map()
        GROUP BY OrgId, Hour, AttributeKey, AttributeScope
      `,
      }),
    ],
  },
);

export const logAttributeKeysMv = defineMaterializedView(
  "log_attribute_keys_mv",
  {
    description: "Aggregates log attribute keys from logs hourly.",
    datasource: attributeKeysHourly,
    nodes: [
      node({
        name: "log_attribute_keys_mv_node",
        sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          arrayJoin(mapKeys(LogAttributes)) AS AttributeKey,
          'log' AS AttributeScope,
          count() AS UsageCount
        FROM logs
        WHERE LogAttributes != map()
        GROUP BY OrgId, Hour, AttributeKey, AttributeScope
      `,
      }),
    ],
  },
);

export const metricAttributeKeysMv = defineMaterializedView(
  "metric_attribute_keys_mv",
  {
    description: "Aggregates metric attribute keys from metrics_sum hourly.",
    datasource: attributeKeysHourly,
    nodes: [
      node({
        name: "metric_attribute_keys_mv_node",
        sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          arrayJoin(mapKeys(Attributes)) AS AttributeKey,
          'metric' AS AttributeScope,
          count() AS UsageCount
        FROM metrics_sum
        WHERE Attributes != map()
        GROUP BY OrgId, Hour, AttributeKey, AttributeScope
      `,
      }),
    ],
  },
);

export const traceSpanAttributeValuesMv = defineMaterializedView(
  "trace_span_attribute_values_mv",
  {
    description: "Aggregates span attribute values from traces hourly.",
    datasource: attributeValuesHourly,
    nodes: [
      node({
        name: "trace_span_attribute_values_mv_node",
        sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          AttributeKey,
          AttributeValue,
          'span' AS AttributeScope,
          count() AS UsageCount
        FROM traces
        ARRAY JOIN
          mapKeys(SpanAttributes) AS AttributeKey,
          mapValues(SpanAttributes) AS AttributeValue
        WHERE AttributeValue != ''
        GROUP BY OrgId, Hour, AttributeKey, AttributeValue, AttributeScope
      `,
      }),
    ],
  },
);

export const traceResourceAttributeValuesMv = defineMaterializedView(
  "trace_resource_attribute_values_mv",
  {
    description: "Aggregates resource attribute values from traces hourly.",
    datasource: attributeValuesHourly,
    nodes: [
      node({
        name: "trace_resource_attribute_values_mv_node",
        sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          AttributeKey,
          AttributeValue,
          'resource' AS AttributeScope,
          count() AS UsageCount
        FROM traces
        ARRAY JOIN
          mapKeys(ResourceAttributes) AS AttributeKey,
          mapValues(ResourceAttributes) AS AttributeValue
        WHERE AttributeValue != ''
        GROUP BY OrgId, Hour, AttributeKey, AttributeValue, AttributeScope
      `,
      }),
    ],
  },
);
