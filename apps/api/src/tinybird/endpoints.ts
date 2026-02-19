import {
  defineEndpoint,
  node,
  t,
  p,
  type InferParams,
  type InferOutputRow,
} from "@tinybirdco/sdk";

/**
 * List traces endpoint - get aggregated trace info with pagination
 */
export const listTraces = defineEndpoint("list_traces", {
  description: "List traces with pagination. Returns aggregated trace info.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    limit: p.int32().optional(100).describe("Number of results"),
    offset: p.int32().optional(0).describe("Offset for pagination"),
    service: p.string().optional().describe("Filter by service name"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    span_name: p.string().optional().describe("Filter by root span name"),
    has_error: p.boolean().optional().describe("Filter traces with errors only"),
    min_duration_ms: p.float64().optional().describe("Minimum duration in milliseconds"),
    max_duration_ms: p.float64().optional().describe("Maximum duration in milliseconds"),
    http_method: p.string().optional().describe("Filter by HTTP method"),
    http_status_code: p.string().optional().describe("Filter by HTTP status code"),
    deployment_env: p.string().optional().describe("Filter by deployment environment"),
    root_only: p.boolean().optional().describe("Filter to root traces only (spans with no parent)"),
  },
  nodes: [
    node({
      name: "base_traces",
      sql: `
        SELECT
          TraceId AS traceId,
          min(Timestamp) AS startTime,
          fromUnixTimestamp64Nano(max(toUnixTimestamp64Nano(Timestamp) + Duration)) AS endTime,
          intDiv(max(toUnixTimestamp64Nano(Timestamp) + Duration) - min(toUnixTimestamp64Nano(Timestamp)), 1000) AS durationMicros,
          count() AS spanCount,
          groupUniqArray(ServiceName) AS services,
          argMin(
            if(
              SpanName LIKE 'http.server %' AND SpanAttributes['http.route'] != '',
              concat(replaceOne(SpanName, 'http.server ', ''), ' ', SpanAttributes['http.route']),
              SpanName
            ),
            if(ParentSpanId = '', 0, 1)
          ) AS rootSpanName,
          max(if(
            StatusCode = 'Error'
            OR (SpanAttributes['http.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.status_code']) >= 500),
            1, 0
          )) AS hasError,
          groupUniqArrayIf(SpanAttributes['http.method'], SpanAttributes['http.method'] != '') AS httpMethods,
          groupUniqArrayIf(SpanAttributes['http.status_code'], SpanAttributes['http.status_code'] != '') AS httpStatusCodes,
          groupUniqArrayIf(ResourceAttributes['deployment.environment'], ResourceAttributes['deployment.environment'] != '') AS deploymentEnvs,
          countIf(ParentSpanId = '') AS rootSpanCount
        FROM traces
        WHERE TraceId != ''
          AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2023-12-31 23:59:59")}}
        {% end %}
        GROUP BY TraceId
      `,
    }),
    node({
      name: "list_traces_node",
      sql: `
        SELECT
          traceId,
          startTime,
          endTime,
          durationMicros,
          spanCount,
          services,
          rootSpanName,
          hasError
        FROM base_traces
        WHERE 1=1
        {% if not defined(root_only) or root_only %}
          AND rootSpanCount > 0
        {% end %}
        {% if defined(span_name) %}
          AND rootSpanName = {{String(span_name, "")}}
        {% end %}
        {% if defined(has_error) and has_error %}
          AND hasError = 1
        {% end %}
        {% if defined(min_duration_ms) %}
          AND durationMicros >= {{Float64(min_duration_ms, 0)}} * 1000
        {% end %}
        {% if defined(max_duration_ms) %}
          AND durationMicros <= {{Float64(max_duration_ms, 999999999)}} * 1000
        {% end %}
        {% if defined(http_method) %}
          AND has(httpMethods, {{String(http_method, "")}})
        {% end %}
        {% if defined(http_status_code) %}
          AND has(httpStatusCodes, {{String(http_status_code, "")}})
        {% end %}
        {% if defined(deployment_env) %}
          AND has(deploymentEnvs, {{String(deployment_env, "")}})
        {% end %}
        ORDER BY startTime DESC
        LIMIT {{Int32(limit, 100)}}
        OFFSET {{Int32(offset, 0)}}
      `,
    }),
  ],
  output: {
    traceId: t.string(),
    startTime: t.dateTime(),
    endTime: t.dateTime(),
    durationMicros: t.int64(),
    spanCount: t.uint64(),
    services: t.array(t.string()),
    rootSpanName: t.string(),
    hasError: t.uint8(),
  },
});

export type ListTracesParams = InferParams<typeof listTraces>;
export type ListTracesOutput = InferOutputRow<typeof listTraces>;

/**
 * Span hierarchy endpoint - get all spans for a trace
 */
export const spanHierarchy = defineEndpoint("span_hierarchy", {
  description: "Get all spans for a trace to build span hierarchy.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    trace_id: p.string().describe("Trace ID (required)"),
    span_id: p.string().optional().describe("Optional span ID to highlight"),
  },
  nodes: [
    node({
      name: "span_hierarchy_node",
      sql: `
        SELECT
          TraceId AS traceId,
          SpanId AS spanId,
          ParentSpanId AS parentSpanId,
          if(
            SpanName LIKE 'http.server %' AND SpanAttributes['http.route'] != '',
            concat(replaceOne(SpanName, 'http.server ', ''), ' ', SpanAttributes['http.route']),
            SpanName
          ) AS spanName,
          ServiceName AS serviceName,
          SpanKind AS spanKind,
          Duration / 1000000 AS durationMs,
          Timestamp AS startTime,
          StatusCode AS statusCode,
          StatusMessage AS statusMessage,
          toJSONString(SpanAttributes) AS spanAttributes,
          toJSONString(ResourceAttributes) AS resourceAttributes,
          {% if defined(span_id) %}
          if(SpanId = {{String(span_id, "")}}, 'target', 'related') AS relationship
          {% else %}
          'related' AS relationship
          {% end %}
        FROM traces
        WHERE TraceId = {{String(trace_id)}}
          AND OrgId = {{String(org_id, "")}}
        ORDER BY Timestamp ASC
      `,
    }),
  ],
  output: {
    traceId: t.string(),
    spanId: t.string(),
    parentSpanId: t.string(),
    spanName: t.string(),
    serviceName: t.string(),
    spanKind: t.string(),
    durationMs: t.float64(),
    startTime: t.dateTime(),
    statusCode: t.string(),
    statusMessage: t.string(),
    spanAttributes: t.string(),
    resourceAttributes: t.string(),
    relationship: t.string(),
  },
});

export type SpanHierarchyParams = InferParams<typeof spanHierarchy>;
export type SpanHierarchyOutput = InferOutputRow<typeof spanHierarchy>;

/**
 * List logs endpoint - paginate through logs with filtering
 */
export const listLogs = defineEndpoint("list_logs", {
  description: "Paginate through logs with optional filtering.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    limit: p.int32().optional(50).describe("Number of results"),
    service: p.string().optional().describe("Filter by service name"),
    severity: p.string().optional().describe("Filter by severity"),
    min_severity: p.uint8().optional().describe("Minimum severity number"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    trace_id: p.string().optional().describe("Filter by trace ID"),
    span_id: p.string().optional().describe("Filter by span ID"),
    cursor: p.dateTime().optional().describe("Cursor for pagination"),
    search: p.string().optional().describe("Search in body"),
  },
  nodes: [
    node({
      name: "list_logs_node",
      sql: `
        SELECT
          Timestamp AS timestamp,
          SeverityText AS severityText,
          SeverityNumber AS severityNumber,
          ServiceName AS serviceName,
          Body AS body,
          TraceId AS traceId,
          SpanId AS spanId,
          toJSONString(LogAttributes) AS logAttributes,
          toJSONString(ResourceAttributes) AS resourceAttributes
        FROM logs
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(severity) %}
          AND SeverityText = {{String(severity, "")}}
        {% end %}
        {% if defined(min_severity) %}
          AND SeverityNumber >= {{UInt8(min_severity, 0)}}
        {% end %}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        {% if defined(trace_id) %}
          AND TraceId = {{String(trace_id, "")}}
        {% end %}
        {% if defined(span_id) %}
          AND SpanId = {{String(span_id, "")}}
        {% end %}
        {% if defined(cursor) %}
          AND Timestamp < {{DateTime(cursor)}}
        {% end %}
        {% if defined(search) %}
          AND Body ILIKE concat('%', {{String(search, "")}}, '%')
        {% end %}
        ORDER BY Timestamp DESC
        LIMIT {{Int32(limit, 50)}}
      `,
    }),
  ],
  output: {
    timestamp: t.dateTime(),
    severityText: t.string(),
    severityNumber: t.uint8(),
    serviceName: t.string(),
    body: t.string(),
    traceId: t.string(),
    spanId: t.string(),
    logAttributes: t.string(),
    resourceAttributes: t.string(),
  },
});

export type ListLogsParams = InferParams<typeof listLogs>;
export type ListLogsOutput = InferOutputRow<typeof listLogs>;

/**
 * Logs count endpoint - get total count of logs
 */
export const logsCount = defineEndpoint("logs_count", {
  description: "Returns total count of logs with optional filtering.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    service: p.string().optional().describe("Filter by service name"),
    severity: p.string().optional().describe("Filter by severity"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    trace_id: p.string().optional().describe("Filter by trace ID"),
    search: p.string().optional().describe("Search in body"),
  },
  nodes: [
    node({
      name: "logs_count_node",
      sql: `
        SELECT count() as total
        FROM logs
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(severity) %}
          AND SeverityText = {{String(severity, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        {% if defined(trace_id) %}
          AND TraceId = {{String(trace_id, "")}}
        {% end %}
        {% if defined(search) %}
          AND Body ILIKE concat('%', {{String(search, "")}}, '%')
        {% end %}
      `,
    }),
  ],
  output: {
    total: t.uint64(),
  },
});

export type LogsCountParams = InferParams<typeof logsCount>;
export type LogsCountOutput = InferOutputRow<typeof logsCount>;

/**
 * Logs facets endpoint - get facet counts for filtering
 */
export const logsFacets = defineEndpoint("logs_facets", {
  description: "Returns facet counts for SeverityText and ServiceName.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    service: p.string().optional().describe("Filter by service name"),
    severity: p.string().optional().describe("Filter by severity"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
  },
  nodes: [
    node({
      name: "severity_facets",
      sql: `
        SELECT
          SeverityText AS severityText,
          '' AS serviceName,
          count() AS count,
          'severity' AS facetType
        FROM logs
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        GROUP BY SeverityText
        ORDER BY count DESC
      `,
    }),
    node({
      name: "service_facets",
      sql: `
        SELECT
          '' AS severityText,
          ServiceName AS serviceName,
          count() AS count,
          'service' AS facetType
        FROM logs
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(severity) %}
          AND SeverityText = {{String(severity, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        GROUP BY ServiceName
        ORDER BY count DESC
      `,
    }),
    node({
      name: "combined_facets",
      sql: `
        SELECT * FROM severity_facets
        UNION ALL
        SELECT * FROM service_facets
      `,
    }),
  ],
  output: {
    severityText: t.string(),
    serviceName: t.string(),
    count: t.uint64(),
    facetType: t.string(),
  },
});

export type LogsFacetsParams = InferParams<typeof logsFacets>;
export type LogsFacetsOutput = InferOutputRow<typeof logsFacets>;

/**
 * Error rate by service endpoint
 */
export const errorRateByService = defineEndpoint("error_rate_by_service", {
  description: "Calculates the error rate grouped by service name.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
  },
  nodes: [
    node({
      name: "error_rate_by_service_node",
      sql: `
        SELECT
          ServiceName AS serviceName,
          count() AS totalLogs,
          countIf(SeverityText IN ('ERROR', 'FATAL')) AS errorLogs,
          round(errorLogs / totalLogs * 100, 2) AS errorRatePercent
        FROM logs
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2023-12-31 23:59:59")}}
        {% end %}
        GROUP BY ServiceName
        ORDER BY errorRatePercent DESC
      `,
    }),
  ],
  output: {
    serviceName: t.string(),
    totalLogs: t.uint64(),
    errorLogs: t.uint64(),
    errorRatePercent: t.float64(),
  },
});

export type ErrorRateByServiceParams = InferParams<typeof errorRateByService>;
export type ErrorRateByServiceOutput = InferOutputRow<typeof errorRateByService>;

/**
 * Get service usage endpoint
 */
export const getServiceUsage = defineEndpoint("get_service_usage", {
  description: "Query aggregated service usage statistics.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    service: p.string().optional().describe("Filter by service name"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
  },
  nodes: [
    node({
      name: "service_usage_node",
      sql: `
        SELECT
          ServiceName AS serviceName,
          sum(LogCount) AS totalLogCount,
          sum(LogSizeBytes) AS totalLogSizeBytes,
          sum(TraceCount) AS totalTraceCount,
          sum(TraceSizeBytes) AS totalTraceSizeBytes,
          sum(SumMetricCount) AS totalSumMetricCount,
          sum(SumMetricSizeBytes) AS totalSumMetricSizeBytes,
          sum(GaugeMetricCount) AS totalGaugeMetricCount,
          sum(GaugeMetricSizeBytes) AS totalGaugeMetricSizeBytes,
          sum(HistogramMetricCount) AS totalHistogramMetricCount,
          sum(HistogramMetricSizeBytes) AS totalHistogramMetricSizeBytes,
          sum(ExpHistogramMetricCount) AS totalExpHistogramMetricCount,
          sum(ExpHistogramMetricSizeBytes) AS totalExpHistogramMetricSizeBytes,
          sum(LogSizeBytes) + sum(TraceSizeBytes) + sum(SumMetricSizeBytes) + sum(GaugeMetricSizeBytes) + sum(HistogramMetricSizeBytes) + sum(ExpHistogramMetricSizeBytes) AS totalSizeBytes
        FROM service_usage
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND Hour >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Hour <= {{DateTime(end_time, "2023-12-31 23:59:59")}}
        {% end %}
        GROUP BY ServiceName
        ORDER BY totalSizeBytes DESC
      `,
    }),
  ],
  output: {
    serviceName: t.string(),
    totalLogCount: t.uint64(),
    totalLogSizeBytes: t.uint64(),
    totalTraceCount: t.uint64(),
    totalTraceSizeBytes: t.uint64(),
    totalSumMetricCount: t.uint64(),
    totalSumMetricSizeBytes: t.uint64(),
    totalGaugeMetricCount: t.uint64(),
    totalGaugeMetricSizeBytes: t.uint64(),
    totalHistogramMetricCount: t.uint64(),
    totalHistogramMetricSizeBytes: t.uint64(),
    totalExpHistogramMetricCount: t.uint64(),
    totalExpHistogramMetricSizeBytes: t.uint64(),
    totalSizeBytes: t.uint64(),
  },
});

export type GetServiceUsageParams = InferParams<typeof getServiceUsage>;
export type GetServiceUsageOutput = InferOutputRow<typeof getServiceUsage>;

/**
 * List metrics endpoint - list available metrics with counts from all metric tables
 */
export const listMetrics = defineEndpoint("list_metrics", {
  description: "List available metrics with counts across all metric types.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    limit: p.int32().optional(100).describe("Number of results"),
    offset: p.int32().optional(0).describe("Offset for pagination"),
    service: p.string().optional().describe("Filter by service name"),
    metric_type: p.string().optional().describe("Filter by metric type (sum, gauge, histogram, exponential_histogram)"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    search: p.string().optional().describe("Search in metric name"),
  },
  nodes: [
    node({
      name: "all_metrics",
      sql: `
        {% if not defined(metric_type) or metric_type == 'sum' %}
        SELECT
          OrgId,
          MetricName AS metricName,
          'sum' AS metricType,
          ServiceName AS serviceName,
          MetricDescription AS metricDescription,
          MetricUnit AS metricUnit,
          count() AS dataPointCount,
          min(TimeUnix) AS firstSeen,
          max(TimeUnix) AS lastSeen
        FROM metrics_sum
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND TimeUnix >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND TimeUnix <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        {% if defined(search) %}
          AND MetricName ILIKE concat('%', {{String(search, "")}}, '%')
        {% end %}
        GROUP BY OrgId, MetricName, ServiceName, MetricDescription, MetricUnit
        {% else %}
        SELECT '' AS metricName, '' AS metricType, '' AS serviceName, '' AS metricDescription, '' AS metricUnit, 0 AS dataPointCount, now() AS firstSeen, now() AS lastSeen, '' AS OrgId WHERE 1=0
        {% end %}

        UNION ALL

        {% if not defined(metric_type) or metric_type == 'gauge' %}
        SELECT
          OrgId,
          MetricName AS metricName,
          'gauge' AS metricType,
          ServiceName AS serviceName,
          MetricDescription AS metricDescription,
          MetricUnit AS metricUnit,
          count() AS dataPointCount,
          min(TimeUnix) AS firstSeen,
          max(TimeUnix) AS lastSeen
        FROM metrics_gauge
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND TimeUnix >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND TimeUnix <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        {% if defined(search) %}
          AND MetricName ILIKE concat('%', {{String(search, "")}}, '%')
        {% end %}
        GROUP BY OrgId, MetricName, ServiceName, MetricDescription, MetricUnit
        {% else %}
        SELECT '' AS metricName, '' AS metricType, '' AS serviceName, '' AS metricDescription, '' AS metricUnit, 0 AS dataPointCount, now() AS firstSeen, now() AS lastSeen, '' AS OrgId WHERE 1=0
        {% end %}

        UNION ALL

        {% if not defined(metric_type) or metric_type == 'histogram' %}
        SELECT
          OrgId,
          MetricName AS metricName,
          'histogram' AS metricType,
          ServiceName AS serviceName,
          MetricDescription AS metricDescription,
          MetricUnit AS metricUnit,
          count() AS dataPointCount,
          min(TimeUnix) AS firstSeen,
          max(TimeUnix) AS lastSeen
        FROM metrics_histogram
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND TimeUnix >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND TimeUnix <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        {% if defined(search) %}
          AND MetricName ILIKE concat('%', {{String(search, "")}}, '%')
        {% end %}
        GROUP BY OrgId, MetricName, ServiceName, MetricDescription, MetricUnit
        {% else %}
        SELECT '' AS metricName, '' AS metricType, '' AS serviceName, '' AS metricDescription, '' AS metricUnit, 0 AS dataPointCount, now() AS firstSeen, now() AS lastSeen, '' AS OrgId WHERE 1=0
        {% end %}

        UNION ALL

        {% if not defined(metric_type) or metric_type == 'exponential_histogram' %}
        SELECT
          OrgId,
          MetricName AS metricName,
          'exponential_histogram' AS metricType,
          ServiceName AS serviceName,
          MetricDescription AS metricDescription,
          MetricUnit AS metricUnit,
          count() AS dataPointCount,
          min(TimeUnix) AS firstSeen,
          max(TimeUnix) AS lastSeen
        FROM metrics_exponential_histogram
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND TimeUnix >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND TimeUnix <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        {% if defined(search) %}
          AND MetricName ILIKE concat('%', {{String(search, "")}}, '%')
        {% end %}
        GROUP BY OrgId, MetricName, ServiceName, MetricDescription, MetricUnit
        {% else %}
        SELECT '' AS metricName, '' AS metricType, '' AS serviceName, '' AS metricDescription, '' AS metricUnit, 0 AS dataPointCount, now() AS firstSeen, now() AS lastSeen, '' AS OrgId WHERE 1=0
        {% end %}
      `,
    }),
    node({
      name: "filtered_metrics",
      sql: `
        SELECT
          metricName,
          metricType,
          serviceName,
          metricDescription,
          metricUnit,
          dataPointCount,
          firstSeen,
          lastSeen
        FROM all_metrics
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(metric_type) %}
          AND metricType = {{String(metric_type, "")}}
        {% end %}
        ORDER BY lastSeen DESC
        LIMIT {{Int32(limit, 100)}}
        OFFSET {{Int32(offset, 0)}}
      `,
    }),
  ],
  output: {
    metricName: t.string(),
    metricType: t.string(),
    serviceName: t.string(),
    metricDescription: t.string(),
    metricUnit: t.string(),
    dataPointCount: t.uint64(),
    firstSeen: t.dateTime64(9),
    lastSeen: t.dateTime64(9),
  },
});

export type ListMetricsParams = InferParams<typeof listMetrics>;
export type ListMetricsOutput = InferOutputRow<typeof listMetrics>;

/**
 * Metric time series endpoint for sum metrics
 */
export const metricTimeSeriesSum = defineEndpoint("metric_time_series_sum", {
  description: "Get time-bucketed sum metric values for charting.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    metric_name: p.string().describe("Metric name (required)"),
    service: p.string().optional().describe("Filter by service name"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    bucket_seconds: p.int32().optional(60).describe("Bucket size in seconds"),
  },
  nodes: [
    node({
      name: "time_series",
      sql: `
        SELECT
          toStartOfInterval(TimeUnix, INTERVAL {{Int32(bucket_seconds, 60)}} SECOND) AS bucket,
          ServiceName AS serviceName,
          avg(Value) AS avgValue,
          min(Value) AS minValue,
          max(Value) AS maxValue,
          sum(Value) AS sumValue,
          count() AS dataPointCount
        FROM metrics_sum
        WHERE MetricName = {{String(metric_name)}}
          AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND TimeUnix >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND TimeUnix <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        GROUP BY bucket, ServiceName
        ORDER BY bucket ASC
      `,
    }),
  ],
  output: {
    bucket: t.dateTime(),
    serviceName: t.string(),
    avgValue: t.float64(),
    minValue: t.float64(),
    maxValue: t.float64(),
    sumValue: t.float64(),
    dataPointCount: t.uint64(),
  },
});

export type MetricTimeSeriesSumParams = InferParams<typeof metricTimeSeriesSum>;
export type MetricTimeSeriesSumOutput = InferOutputRow<typeof metricTimeSeriesSum>;

/**
 * Metric time series endpoint for gauge metrics
 */
export const metricTimeSeriesGauge = defineEndpoint("metric_time_series_gauge", {
  description: "Get time-bucketed gauge metric values for charting.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    metric_name: p.string().describe("Metric name (required)"),
    service: p.string().optional().describe("Filter by service name"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    bucket_seconds: p.int32().optional(60).describe("Bucket size in seconds"),
  },
  nodes: [
    node({
      name: "time_series",
      sql: `
        SELECT
          toStartOfInterval(TimeUnix, INTERVAL {{Int32(bucket_seconds, 60)}} SECOND) AS bucket,
          ServiceName AS serviceName,
          avg(Value) AS avgValue,
          min(Value) AS minValue,
          max(Value) AS maxValue,
          sum(Value) AS sumValue,
          count() AS dataPointCount
        FROM metrics_gauge
        WHERE MetricName = {{String(metric_name)}}
          AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND TimeUnix >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND TimeUnix <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        GROUP BY bucket, ServiceName
        ORDER BY bucket ASC
      `,
    }),
  ],
  output: {
    bucket: t.dateTime(),
    serviceName: t.string(),
    avgValue: t.float64(),
    minValue: t.float64(),
    maxValue: t.float64(),
    sumValue: t.float64(),
    dataPointCount: t.uint64(),
  },
});

export type MetricTimeSeriesGaugeParams = InferParams<typeof metricTimeSeriesGauge>;
export type MetricTimeSeriesGaugeOutput = InferOutputRow<typeof metricTimeSeriesGauge>;

/**
 * Metric time series endpoint for histogram metrics
 */
export const metricTimeSeriesHistogram = defineEndpoint("metric_time_series_histogram", {
  description: "Get time-bucketed histogram metric values for charting.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    metric_name: p.string().describe("Metric name (required)"),
    service: p.string().optional().describe("Filter by service name"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    bucket_seconds: p.int32().optional(60).describe("Bucket size in seconds"),
  },
  nodes: [
    node({
      name: "time_series",
      sql: `
        SELECT
          toStartOfInterval(TimeUnix, INTERVAL {{Int32(bucket_seconds, 60)}} SECOND) AS bucket,
          ServiceName AS serviceName,
          if(sum(Count) > 0, sum(Sum) / sum(Count), 0) AS avgValue,
          min(Min) AS minValue,
          max(Max) AS maxValue,
          sum(Sum) AS sumValue,
          sum(Count) AS dataPointCount
        FROM metrics_histogram
        WHERE MetricName = {{String(metric_name)}}
          AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND TimeUnix >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND TimeUnix <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        GROUP BY bucket, ServiceName
        ORDER BY bucket ASC
      `,
    }),
  ],
  output: {
    bucket: t.dateTime(),
    serviceName: t.string(),
    avgValue: t.float64(),
    minValue: t.float64(),
    maxValue: t.float64(),
    sumValue: t.float64(),
    dataPointCount: t.uint64(),
  },
});

export type MetricTimeSeriesHistogramParams = InferParams<typeof metricTimeSeriesHistogram>;
export type MetricTimeSeriesHistogramOutput = InferOutputRow<typeof metricTimeSeriesHistogram>;

/**
 * Metric time series endpoint for exponential histogram metrics
 */
export const metricTimeSeriesExpHistogram = defineEndpoint("metric_time_series_exp_histogram", {
  description: "Get time-bucketed exponential histogram metric values for charting.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    metric_name: p.string().describe("Metric name (required)"),
    service: p.string().optional().describe("Filter by service name"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    bucket_seconds: p.int32().optional(60).describe("Bucket size in seconds"),
  },
  nodes: [
    node({
      name: "time_series",
      sql: `
        SELECT
          toStartOfInterval(TimeUnix, INTERVAL {{Int32(bucket_seconds, 60)}} SECOND) AS bucket,
          ServiceName AS serviceName,
          if(sum(Count) > 0, sum(Sum) / sum(Count), 0) AS avgValue,
          min(Min) AS minValue,
          max(Max) AS maxValue,
          sum(Sum) AS sumValue,
          sum(Count) AS dataPointCount
        FROM metrics_exponential_histogram
        WHERE MetricName = {{String(metric_name)}}
          AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND TimeUnix >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND TimeUnix <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        GROUP BY bucket, ServiceName
        ORDER BY bucket ASC
      `,
    }),
  ],
  output: {
    bucket: t.dateTime(),
    serviceName: t.string(),
    avgValue: t.float64(),
    minValue: t.float64(),
    maxValue: t.float64(),
    sumValue: t.float64(),
    dataPointCount: t.uint64(),
  },
});

export type MetricTimeSeriesExpHistogramParams = InferParams<typeof metricTimeSeriesExpHistogram>;
export type MetricTimeSeriesExpHistogramOutput = InferOutputRow<typeof metricTimeSeriesExpHistogram>;

/**
 * Metrics summary endpoint - get counts by metric type for summary cards
 */
export const metricsSummary = defineEndpoint("metrics_summary", {
  description: "Get summary counts by metric type.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    service: p.string().optional().describe("Filter by service name"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
  },
  nodes: [
    node({
      name: "sum_count",
      sql: `
        SELECT
          'sum' AS metricType,
          count(DISTINCT MetricName) AS metricCount,
          count() AS dataPointCount
        FROM metrics_sum
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND TimeUnix >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND TimeUnix <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
      `,
    }),
    node({
      name: "gauge_count",
      sql: `
        SELECT
          'gauge' AS metricType,
          count(DISTINCT MetricName) AS metricCount,
          count() AS dataPointCount
        FROM metrics_gauge
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND TimeUnix >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND TimeUnix <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
      `,
    }),
    node({
      name: "histogram_count",
      sql: `
        SELECT
          'histogram' AS metricType,
          count(DISTINCT MetricName) AS metricCount,
          count() AS dataPointCount
        FROM metrics_histogram
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND TimeUnix >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND TimeUnix <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
      `,
    }),
    node({
      name: "exponential_histogram_count",
      sql: `
        SELECT
          'exponential_histogram' AS metricType,
          count(DISTINCT MetricName) AS metricCount,
          count() AS dataPointCount
        FROM metrics_exponential_histogram
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(service) %}
          AND ServiceName = {{String(service, "")}}
        {% end %}
        {% if defined(start_time) %}
          AND TimeUnix >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND TimeUnix <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
      `,
    }),
    node({
      name: "metrics_summary_result",
      sql: `
        SELECT * FROM sum_count
        UNION ALL
        SELECT * FROM gauge_count
        UNION ALL
        SELECT * FROM histogram_count
        UNION ALL
        SELECT * FROM exponential_histogram_count
      `,
    }),
  ],
  output: {
    metricType: t.string(),
    metricCount: t.uint64(),
    dataPointCount: t.uint64(),
  },
});

export type MetricsSummaryParams = InferParams<typeof metricsSummary>;
export type MetricsSummaryOutput = InferOutputRow<typeof metricsSummary>;

/**
 * Traces facets endpoint - get facet counts for filtering
 */
export const tracesFacets = defineEndpoint("traces_facets", {
  description: "Returns facet counts for trace filtering (services, span names, HTTP methods, status codes, environments).",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    service: p.string().optional().describe("Filter by service name"),
    span_name: p.string().optional().describe("Filter by span name"),
    has_error: p.boolean().optional().describe("Filter to only errors"),
    min_duration_ms: p.float64().optional().describe("Minimum duration in milliseconds"),
    max_duration_ms: p.float64().optional().describe("Maximum duration in milliseconds"),
    http_method: p.string().optional().describe("Filter by HTTP method"),
    http_status_code: p.string().optional().describe("Filter by HTTP status code"),
    deployment_env: p.string().optional().describe("Filter by deployment environment"),
  },
  nodes: [
    node({
      name: "trace_summaries",
      sql: `
        SELECT
          TraceId,
          groupUniqArray(ServiceName) AS services,
          argMin(
            if(
              SpanName LIKE 'http.server %' AND SpanAttributes['http.route'] != '',
              concat(replaceOne(SpanName, 'http.server ', ''), ' ', SpanAttributes['http.route']),
              SpanName
            ),
            if(ParentSpanId = '', 0, 1)
          ) AS rootSpanName,
          groupUniqArrayIf(SpanAttributes['http.method'], SpanAttributes['http.method'] != '') AS httpMethods,
          groupUniqArrayIf(SpanAttributes['http.status_code'], SpanAttributes['http.status_code'] != '') AS httpStatusCodes,
          groupUniqArrayIf(ResourceAttributes['deployment.environment'], ResourceAttributes['deployment.environment'] != '') AS deploymentEnvs,
          max(if(
            StatusCode = 'Error'
            OR (SpanAttributes['http.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.status_code']) >= 500),
            1, 0
          )) AS hasError,
          (max(toUnixTimestamp64Nano(Timestamp) + Duration) - min(toUnixTimestamp64Nano(Timestamp))) / 1000000.0 AS durationMs
        FROM traces
        WHERE TraceId != ''
          AND OrgId = {{String(org_id, "")}}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        GROUP BY TraceId
      `,
    }),
    node({
      name: "service_facets",
      sql: `
        SELECT
          service AS name,
          count() AS count,
          'service' AS facetType
        FROM trace_summaries
        ARRAY JOIN services AS service
        WHERE 1=1
        {% if defined(span_name) %}
          AND rootSpanName = {{String(span_name)}}
        {% end %}
        {% if defined(has_error) and has_error %}
          AND hasError = 1
        {% end %}
        {% if defined(min_duration_ms) %}
          AND durationMs >= {{Float64(min_duration_ms)}}
        {% end %}
        {% if defined(max_duration_ms) %}
          AND durationMs <= {{Float64(max_duration_ms)}}
        {% end %}
        {% if defined(http_method) %}
          AND has(httpMethods, {{String(http_method)}})
        {% end %}
        {% if defined(http_status_code) %}
          AND has(httpStatusCodes, {{String(http_status_code)}})
        {% end %}
        {% if defined(deployment_env) %}
          AND has(deploymentEnvs, {{String(deployment_env)}})
        {% end %}
        GROUP BY service
        ORDER BY count DESC
        LIMIT 50
      `,
    }),
    node({
      name: "span_name_facets",
      sql: `
        SELECT
          rootSpanName AS name,
          count() AS count,
          'spanName' AS facetType
        FROM trace_summaries
        WHERE 1=1
        {% if defined(service) %}
          AND has(services, {{String(service)}})
        {% end %}
        {% if defined(has_error) and has_error %}
          AND hasError = 1
        {% end %}
        {% if defined(min_duration_ms) %}
          AND durationMs >= {{Float64(min_duration_ms)}}
        {% end %}
        {% if defined(max_duration_ms) %}
          AND durationMs <= {{Float64(max_duration_ms)}}
        {% end %}
        {% if defined(http_method) %}
          AND has(httpMethods, {{String(http_method)}})
        {% end %}
        {% if defined(http_status_code) %}
          AND has(httpStatusCodes, {{String(http_status_code)}})
        {% end %}
        {% if defined(deployment_env) %}
          AND has(deploymentEnvs, {{String(deployment_env)}})
        {% end %}
        GROUP BY rootSpanName
        ORDER BY count DESC
        LIMIT 50
      `,
    }),
    node({
      name: "http_method_facets",
      sql: `
        SELECT
          method AS name,
          count() AS count,
          'httpMethod' AS facetType
        FROM trace_summaries
        ARRAY JOIN httpMethods AS method
        WHERE 1=1
        {% if defined(service) %}
          AND has(services, {{String(service)}})
        {% end %}
        {% if defined(span_name) %}
          AND rootSpanName = {{String(span_name)}}
        {% end %}
        {% if defined(has_error) and has_error %}
          AND hasError = 1
        {% end %}
        {% if defined(min_duration_ms) %}
          AND durationMs >= {{Float64(min_duration_ms)}}
        {% end %}
        {% if defined(max_duration_ms) %}
          AND durationMs <= {{Float64(max_duration_ms)}}
        {% end %}
        {% if defined(http_status_code) %}
          AND has(httpStatusCodes, {{String(http_status_code)}})
        {% end %}
        {% if defined(deployment_env) %}
          AND has(deploymentEnvs, {{String(deployment_env)}})
        {% end %}
        GROUP BY method
        ORDER BY count DESC
        LIMIT 20
      `,
    }),
    node({
      name: "http_status_facets",
      sql: `
        SELECT
          status AS name,
          count() AS count,
          'httpStatus' AS facetType
        FROM trace_summaries
        ARRAY JOIN httpStatusCodes AS status
        WHERE 1=1
        {% if defined(service) %}
          AND has(services, {{String(service)}})
        {% end %}
        {% if defined(span_name) %}
          AND rootSpanName = {{String(span_name)}}
        {% end %}
        {% if defined(has_error) and has_error %}
          AND hasError = 1
        {% end %}
        {% if defined(min_duration_ms) %}
          AND durationMs >= {{Float64(min_duration_ms)}}
        {% end %}
        {% if defined(max_duration_ms) %}
          AND durationMs <= {{Float64(max_duration_ms)}}
        {% end %}
        {% if defined(http_method) %}
          AND has(httpMethods, {{String(http_method)}})
        {% end %}
        {% if defined(deployment_env) %}
          AND has(deploymentEnvs, {{String(deployment_env)}})
        {% end %}
        GROUP BY status
        ORDER BY count DESC
        LIMIT 20
      `,
    }),
    node({
      name: "deployment_env_facets",
      sql: `
        SELECT
          env AS name,
          count() AS count,
          'deploymentEnv' AS facetType
        FROM trace_summaries
        ARRAY JOIN deploymentEnvs AS env
        WHERE 1=1
        {% if defined(service) %}
          AND has(services, {{String(service)}})
        {% end %}
        {% if defined(span_name) %}
          AND rootSpanName = {{String(span_name)}}
        {% end %}
        {% if defined(has_error) and has_error %}
          AND hasError = 1
        {% end %}
        {% if defined(min_duration_ms) %}
          AND durationMs >= {{Float64(min_duration_ms)}}
        {% end %}
        {% if defined(max_duration_ms) %}
          AND durationMs <= {{Float64(max_duration_ms)}}
        {% end %}
        {% if defined(http_method) %}
          AND has(httpMethods, {{String(http_method)}})
        {% end %}
        {% if defined(http_status_code) %}
          AND has(httpStatusCodes, {{String(http_status_code)}})
        {% end %}
        GROUP BY env
        ORDER BY count DESC
        LIMIT 20
      `,
    }),
    node({
      name: "error_count",
      sql: `
        SELECT
          'error' AS name,
          countIf(hasError = 1) AS count,
          'errorCount' AS facetType
        FROM trace_summaries
        WHERE 1=1
        {% if defined(service) %}
          AND has(services, {{String(service)}})
        {% end %}
        {% if defined(span_name) %}
          AND rootSpanName = {{String(span_name)}}
        {% end %}
        {% if defined(min_duration_ms) %}
          AND durationMs >= {{Float64(min_duration_ms)}}
        {% end %}
        {% if defined(max_duration_ms) %}
          AND durationMs <= {{Float64(max_duration_ms)}}
        {% end %}
        {% if defined(http_method) %}
          AND has(httpMethods, {{String(http_method)}})
        {% end %}
        {% if defined(http_status_code) %}
          AND has(httpStatusCodes, {{String(http_status_code)}})
        {% end %}
        {% if defined(deployment_env) %}
          AND has(deploymentEnvs, {{String(deployment_env)}})
        {% end %}
      `,
    }),
    node({
      name: "combined_facets",
      sql: `
        SELECT * FROM service_facets
        UNION ALL
        SELECT * FROM span_name_facets
        UNION ALL
        SELECT * FROM http_method_facets
        UNION ALL
        SELECT * FROM http_status_facets
        UNION ALL
        SELECT * FROM deployment_env_facets
        UNION ALL
        SELECT * FROM error_count
      `,
    }),
  ],
  output: {
    name: t.string(),
    count: t.uint64(),
    facetType: t.string(),
  },
});

export type TracesFacetsParams = InferParams<typeof tracesFacets>;
export type TracesFacetsOutput = InferOutputRow<typeof tracesFacets>;

/**
 * Traces duration stats endpoint - get min, max, p50, p95 durations
 */
export const tracesDurationStats = defineEndpoint("traces_duration_stats", {
  description: "Returns duration statistics (min, max, p50, p95) for traces.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    service: p.string().optional().describe("Filter by service name"),
    span_name: p.string().optional().describe("Filter by span name"),
    has_error: p.boolean().optional().describe("Filter to only errors"),
    http_method: p.string().optional().describe("Filter by HTTP method"),
    http_status_code: p.string().optional().describe("Filter by HTTP status code"),
    deployment_env: p.string().optional().describe("Filter by deployment environment"),
  },
  nodes: [
    node({
      name: "duration_stats_node",
      sql: `
        SELECT
          min(durationMs) AS minDurationMs,
          max(durationMs) AS maxDurationMs,
          quantile(0.50)(durationMs) AS p50DurationMs,
          quantile(0.95)(durationMs) AS p95DurationMs
        FROM (
          SELECT
            TraceId,
            (max(toUnixTimestamp64Nano(Timestamp) + Duration) - min(toUnixTimestamp64Nano(Timestamp))) / 1000000.0 AS durationMs
          FROM traces
          WHERE TraceId != ''
          AND OrgId = {{String(org_id, "")}}
          {% if defined(start_time) %}
            AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
          {% end %}
          {% if defined(end_time) %}
            AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
          {% end %}
          {% if defined(service) %}
            AND ServiceName = {{String(service)}}
          {% end %}
          {% if defined(span_name) %}
            AND ParentSpanId = '' AND SpanName = {{String(span_name)}}
          {% end %}
          {% if defined(has_error) and has_error %}
            AND TraceId IN (
              SELECT TraceId FROM traces WHERE TraceId != ''
          AND OrgId = {{String(org_id, "")}} AND (
                StatusCode = 'Error' OR (SpanAttributes['http.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.status_code']) >= 500)
              )
              {% if defined(start_time) %}
                AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
              {% end %}
              {% if defined(end_time) %}
                AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
              {% end %}
              GROUP BY TraceId
            )
          {% end %}
          {% if defined(http_method) %}
            AND SpanAttributes['http.method'] = {{String(http_method)}}
          {% end %}
          {% if defined(http_status_code) %}
            AND SpanAttributes['http.status_code'] = {{String(http_status_code)}}
          {% end %}
          {% if defined(deployment_env) %}
            AND ResourceAttributes['deployment.environment'] = {{String(deployment_env)}}
          {% end %}
          GROUP BY TraceId
        )
      `,
    }),
  ],
  output: {
    minDurationMs: t.float64(),
    maxDurationMs: t.float64(),
    p50DurationMs: t.float64(),
    p95DurationMs: t.float64(),
  },
});

export type TracesDurationStatsParams = InferParams<typeof tracesDurationStats>;
export type TracesDurationStatsOutput = InferOutputRow<typeof tracesDurationStats>;

/**
 * Service overview endpoint - get aggregated service metrics
 */
export const serviceOverview = defineEndpoint("service_overview", {
  description: "Get aggregated service metrics including P99 latency, error rate, and throughput.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    environments: p.string().optional().describe("Comma-separated list of environments to filter"),
    commit_shas: p.string().optional().describe("Comma-separated list of commit SHAs to filter"),
  },
  nodes: [
    node({
      name: "service_overview_node",
      sql: `
        SELECT
          ServiceName AS serviceName,
          ResourceAttributes['deployment.environment'] AS environment,
          ResourceAttributes['deployment.commit_sha'] AS commitSha,
          count() AS throughput,
          countIf(StatusCode = 'Error') AS errorCount,
          count() AS spanCount,
          quantile(0.50)(Duration / 1000000) AS p50LatencyMs,
          quantile(0.95)(Duration / 1000000) AS p95LatencyMs,
          quantile(0.99)(Duration / 1000000) AS p99LatencyMs,
          countIf(TraceState LIKE '%th:%') AS sampledSpanCount,
          countIf(TraceState = '' OR TraceState NOT LIKE '%th:%') AS unsampledSpanCount,
          anyIf(extract(TraceState, 'th:([0-9a-f]+)'), TraceState LIKE '%th:%') AS dominantThreshold
        FROM traces
        WHERE ParentSpanId = ''
          AND OrgId = {{String(org_id, "")}}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        {% if defined(environments) %}
          AND ResourceAttributes['deployment.environment'] IN splitByChar(',', {{String(environments, "")}})
        {% end %}
        {% if defined(commit_shas) %}
          AND ResourceAttributes['deployment.commit_sha'] IN splitByChar(',', {{String(commit_shas, "")}})
        {% end %}
        GROUP BY serviceName, environment, commitSha
        ORDER BY throughput DESC
        LIMIT 100
      `,
    }),
  ],
  output: {
    serviceName: t.string(),
    environment: t.string(),
    commitSha: t.string(),
    throughput: t.uint64(),
    errorCount: t.uint64(),
    spanCount: t.uint64(),
    p50LatencyMs: t.float64(),
    p95LatencyMs: t.float64(),
    p99LatencyMs: t.float64(),
    sampledSpanCount: t.uint64(),
    unsampledSpanCount: t.uint64(),
    dominantThreshold: t.string(),
  },
});

export type ServiceOverviewParams = InferParams<typeof serviceOverview>;
export type ServiceOverviewOutput = InferOutputRow<typeof serviceOverview>;

/**
 * Service overview time series endpoint - get throughput and error rate bucketed over time per service
 */
/**
 * Service facets endpoint - get filter options for services page
 */
export const servicesFacets = defineEndpoint("services_facets", {
  description: "Get facet counts for environment and commit SHA filters.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
  },
  nodes: [
    node({
      name: "environment_facets",
      sql: `
        SELECT
          ResourceAttributes['deployment.environment'] AS name,
          count() AS count,
          'environment' AS facetType
        FROM traces
        WHERE ResourceAttributes['deployment.environment'] != ''
          AND OrgId = {{String(org_id, "")}}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
      `,
    }),
    node({
      name: "commit_sha_facets",
      sql: `
        SELECT
          ResourceAttributes['deployment.commit_sha'] AS name,
          count() AS count,
          'commitSha' AS facetType
        FROM traces
        WHERE ResourceAttributes['deployment.commit_sha'] != ''
          AND OrgId = {{String(org_id, "")}}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        GROUP BY name
        ORDER BY count DESC
        LIMIT 50
      `,
    }),
    node({
      name: "combined_facets",
      sql: `
        SELECT * FROM environment_facets
        UNION ALL
        SELECT * FROM commit_sha_facets
      `,
    }),
  ],
  output: {
    name: t.string(),
    count: t.uint64(),
    facetType: t.string(),
  },
});

export type ServicesFacetsParams = InferParams<typeof servicesFacets>;
export type ServicesFacetsOutput = InferOutputRow<typeof servicesFacets>;

/**
 * Errors by type endpoint - get aggregated error counts grouped by error type
 */
export const errorsByType = defineEndpoint("errors_by_type", {
  description: "Get errors grouped by StatusMessage/error type.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    services: p.string().optional().describe("Comma-separated list of services to filter"),
    deployment_envs: p.string().optional().describe("Comma-separated list of environments to filter"),
    error_types: p.string().optional().describe("Comma-separated list of error types to filter"),
    limit: p.int32().optional(50).describe("Maximum number of results"),
    exclude_spam_patterns: p.string().optional().describe("Comma-separated spam patterns to exclude"),
  },
  nodes: [
    node({
      name: "errors_by_type_node",
      sql: `
        SELECT
          if(StatusMessage = '', 'Unknown Error', StatusMessage) AS errorType,
          count() AS count,
          uniq(ServiceName) AS affectedServicesCount,
          min(Timestamp) AS firstSeen,
          max(Timestamp) AS lastSeen,
          groupUniqArray(ServiceName) AS affectedServices
        FROM traces
        WHERE StatusCode = 'Error'
          AND OrgId = {{String(org_id, "")}}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        {% if defined(services) %}
          AND ServiceName IN splitByChar(',', {{String(services, "")}})
        {% end %}
        {% if defined(deployment_envs) %}
          AND ResourceAttributes['deployment.environment'] IN splitByChar(',', {{String(deployment_envs, "")}})
        {% end %}
        {% if defined(error_types) %}
          AND if(StatusMessage = '', 'Unknown Error', StatusMessage) IN splitByChar(',', {{String(error_types, "")}})
        {% end %}
        {% if defined(exclude_spam_patterns) %}
          AND NOT arrayExists(
            x -> positionCaseInsensitive(
              if(StatusMessage = '', 'Unknown Error', StatusMessage), x
            ) > 0,
            splitByChar(',', {{String(exclude_spam_patterns, "")}})
          )
        {% end %}
        GROUP BY errorType
        ORDER BY count DESC
        LIMIT {{Int32(limit, 50)}}
      `,
    }),
  ],
  output: {
    errorType: t.string(),
    count: t.uint64(),
    affectedServicesCount: t.uint64(),
    firstSeen: t.dateTime(),
    lastSeen: t.dateTime(),
    affectedServices: t.array(t.string()),
  },
});

export type ErrorsByTypeParams = InferParams<typeof errorsByType>;
export type ErrorsByTypeOutput = InferOutputRow<typeof errorsByType>;

/**
 * Error detail traces endpoint - get sample traces for a specific error type
 */
export const errorDetailTraces = defineEndpoint("error_detail_traces", {
  description: "Get sample traces for a specific error type with trace metadata.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    error_type: p.string().describe("The error type/StatusMessage to filter by"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    services: p.string().optional().describe("Comma-separated list of services to filter"),
    limit: p.int32().optional(10).describe("Maximum number of sample traces"),
    exclude_spam_patterns: p.string().optional().describe("Comma-separated spam patterns to exclude"),
  },
  nodes: [
    node({
      name: "error_trace_ids",
      sql: `
        SELECT DISTINCT TraceId
        FROM traces
        WHERE StatusCode = 'Error'
          AND OrgId = {{String(org_id, "")}}
        AND if(StatusMessage = '', 'Unknown Error', StatusMessage) = {{String(error_type)}}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        {% if defined(services) %}
          AND ServiceName IN splitByChar(',', {{String(services, "")}})
        {% end %}
        {% if defined(exclude_spam_patterns) %}
          AND NOT arrayExists(
            x -> positionCaseInsensitive(
              if(StatusMessage = '', 'Unknown Error', StatusMessage), x
            ) > 0,
            splitByChar(',', {{String(exclude_spam_patterns, "")}})
          )
        {% end %}
        ORDER BY Timestamp DESC
        LIMIT {{Int32(limit, 10)}}
      `,
    }),
    node({
      name: "error_detail_traces_node",
      sql: `
        SELECT
          t.TraceId AS traceId,
          min(t.Timestamp) AS startTime,
          intDiv(max(toUnixTimestamp64Nano(t.Timestamp) + t.Duration) - min(toUnixTimestamp64Nano(t.Timestamp)), 1000) AS durationMicros,
          count() AS spanCount,
          groupUniqArray(t.ServiceName) AS services,
          argMin(
            if(
              t.SpanName LIKE 'http.server %' AND t.SpanAttributes['http.route'] != '',
              concat(replaceOne(t.SpanName, 'http.server ', ''), ' ', t.SpanAttributes['http.route']),
              t.SpanName
            ),
            if(t.ParentSpanId = '', 0, 1)
          ) AS rootSpanName,
          anyIf(t.StatusMessage, t.StatusCode = 'Error' AND t.StatusMessage != '') AS errorMessage
        FROM traces AS t
        INNER JOIN error_trace_ids AS e ON t.TraceId = e.TraceId AND t.OrgId = {{String(org_id, "")}}
        GROUP BY t.TraceId
        ORDER BY startTime DESC
      `,
    }),
  ],
  output: {
    traceId: t.string(),
    startTime: t.dateTime(),
    durationMicros: t.int64(),
    spanCount: t.uint64(),
    services: t.array(t.string()),
    rootSpanName: t.string(),
    errorMessage: t.string(),
  },
});

export type ErrorDetailTracesParams = InferParams<typeof errorDetailTraces>;
export type ErrorDetailTracesOutput = InferOutputRow<typeof errorDetailTraces>;

/**
 * Errors facets endpoint - get facet counts for error filtering
 */
export const errorsFacets = defineEndpoint("errors_facets", {
  description: "Returns facet counts for error filtering (services, environments, error types).",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    services: p.string().optional().describe("Comma-separated list of services to filter"),
    deployment_envs: p.string().optional().describe("Comma-separated list of environments to filter"),
    error_types: p.string().optional().describe("Comma-separated list of error types to filter"),
    exclude_spam_patterns: p.string().optional().describe("Comma-separated spam patterns to exclude"),
  },
  nodes: [
    node({
      name: "error_base",
      sql: `
        SELECT
          ServiceName AS serviceName,
          ResourceAttributes['deployment.environment'] AS deploymentEnv,
          if(StatusMessage = '', 'Unknown Error', StatusMessage) AS errorType
        FROM traces
        WHERE StatusCode = 'Error'
          AND OrgId = {{String(org_id, "")}}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        {% if defined(exclude_spam_patterns) %}
          AND NOT arrayExists(
            x -> positionCaseInsensitive(
              if(StatusMessage = '', 'Unknown Error', StatusMessage), x
            ) > 0,
            splitByChar(',', {{String(exclude_spam_patterns, "")}})
          )
        {% end %}
      `,
    }),
    node({
      name: "service_error_facets",
      sql: `
        SELECT
          serviceName AS name,
          count() AS count,
          'service' AS facetType
        FROM error_base
        WHERE 1=1
        {% if defined(deployment_envs) %}
          AND deploymentEnv IN splitByChar(',', {{String(deployment_envs, "")}})
        {% end %}
        {% if defined(error_types) %}
          AND errorType IN splitByChar(',', {{String(error_types, "")}})
        {% end %}
        GROUP BY serviceName
        ORDER BY count DESC
      `,
    }),
    node({
      name: "environment_error_facets",
      sql: `
        SELECT
          deploymentEnv AS name,
          count() AS count,
          'deploymentEnv' AS facetType
        FROM error_base
        WHERE deploymentEnv != ''
        {% if defined(services) %}
          AND serviceName IN splitByChar(',', {{String(services, "")}})
        {% end %}
        {% if defined(error_types) %}
          AND errorType IN splitByChar(',', {{String(error_types, "")}})
        {% end %}
        GROUP BY deploymentEnv
        ORDER BY count DESC
      `,
    }),
    node({
      name: "error_type_facets",
      sql: `
        SELECT
          errorType AS name,
          count() AS count,
          'errorType' AS facetType
        FROM error_base
        WHERE 1=1
        {% if defined(services) %}
          AND serviceName IN splitByChar(',', {{String(services, "")}})
        {% end %}
        {% if defined(deployment_envs) %}
          AND deploymentEnv IN splitByChar(',', {{String(deployment_envs, "")}})
        {% end %}
        GROUP BY errorType
        ORDER BY count DESC
        LIMIT 50
      `,
    }),
    node({
      name: "combined_error_facets",
      sql: `
        SELECT * FROM service_error_facets
        UNION ALL
        SELECT * FROM environment_error_facets
        UNION ALL
        SELECT * FROM error_type_facets
      `,
    }),
  ],
  output: {
    name: t.string(),
    count: t.uint64(),
    facetType: t.string(),
  },
});

export type ErrorsFacetsParams = InferParams<typeof errorsFacets>;
export type ErrorsFacetsOutput = InferOutputRow<typeof errorsFacets>;

/**
 * Errors summary endpoint - get total error stats
 */
export const errorsSummary = defineEndpoint("errors_summary", {
  description: "Get summary error statistics including total count, rate, and affected services.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    services: p.string().optional().describe("Comma-separated list of services to filter"),
    deployment_envs: p.string().optional().describe("Comma-separated list of environments to filter"),
    error_types: p.string().optional().describe("Comma-separated list of error types to filter"),
    exclude_spam_patterns: p.string().optional().describe("Comma-separated spam patterns to exclude"),
  },
  nodes: [
    node({
      name: "errors_summary_node",
      sql: `
        SELECT
          countIf(StatusCode = 'Error') AS totalErrors,
          count() AS totalSpans,
          if(totalSpans > 0, round(totalErrors / totalSpans * 100, 2), 0) AS errorRate,
          uniqIf(ServiceName, StatusCode = 'Error') AS affectedServicesCount,
          uniqIf(TraceId, StatusCode = 'Error') AS affectedTracesCount
        FROM traces
        WHERE 1=1
        AND OrgId = {{String(org_id, "")}}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        {% if defined(services) %}
          AND ServiceName IN splitByChar(',', {{String(services, "")}})
        {% end %}
        {% if defined(deployment_envs) %}
          AND ResourceAttributes['deployment.environment'] IN splitByChar(',', {{String(deployment_envs, "")}})
        {% end %}
        {% if defined(error_types) %}
          AND (StatusCode != 'Error' OR if(StatusMessage = '', 'Unknown Error', StatusMessage) IN splitByChar(',', {{String(error_types, "")}}))
        {% end %}
        {% if defined(exclude_spam_patterns) %}
          AND (
            StatusCode != 'Error'
            OR NOT arrayExists(
              x -> positionCaseInsensitive(
                if(StatusMessage = '', 'Unknown Error', StatusMessage), x
              ) > 0,
              splitByChar(',', {{String(exclude_spam_patterns, "")}})
            )
          )
        {% end %}
      `,
    }),
  ],
  output: {
    totalErrors: t.uint64(),
    totalSpans: t.uint64(),
    errorRate: t.float64(),
    affectedServicesCount: t.uint64(),
    affectedTracesCount: t.uint64(),
  },
});

export type ErrorsSummaryParams = InferParams<typeof errorsSummary>;
export type ErrorsSummaryOutput = InferOutputRow<typeof errorsSummary>;

/**
 * Service detail time series endpoint - P50/P95/P99 latency + throughput + error count for a single service
 */
/**
 * Service Apdex time series endpoint - time-bucketed Apdex score for a single service
 */
export const serviceApdexTimeSeries = defineEndpoint("service_apdex_time_series", {
  description: "Get time-bucketed Apdex score for a single service.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    service_name: p.string().describe("Service name (required)"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    bucket_seconds: p.int32().optional(60).describe("Bucket interval in seconds"),
    apdex_threshold_ms: p.float64().optional(500).describe("Apdex threshold T in milliseconds"),
  },
  nodes: [
    node({
      name: "service_apdex_time_series_node",
      sql: `
        SELECT
          toStartOfInterval(Timestamp, INTERVAL {{Int32(bucket_seconds, 60)}} second) AS bucket,
          count() AS totalCount,
          countIf(Duration / 1000000 < {{Float64(apdex_threshold_ms, 500)}}) AS satisfiedCount,
          countIf(Duration / 1000000 >= {{Float64(apdex_threshold_ms, 500)}}
            AND Duration / 1000000 < {{Float64(apdex_threshold_ms, 500)}} * 4) AS toleratingCount,
          if(count() > 0,
            round((countIf(Duration / 1000000 < {{Float64(apdex_threshold_ms, 500)}})
              + countIf(Duration / 1000000 >= {{Float64(apdex_threshold_ms, 500)}}
                  AND Duration / 1000000 < {{Float64(apdex_threshold_ms, 500)}} * 4) * 0.5
            ) / count(), 4), 0
          ) AS apdexScore
        FROM traces
        WHERE ParentSpanId = ''
          AND OrgId = {{String(org_id, "")}}
          AND ServiceName = {{String(service_name)}}
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        GROUP BY bucket
        ORDER BY bucket ASC
      `,
    }),
  ],
  output: {
    bucket: t.dateTime(),
    totalCount: t.uint64(),
    satisfiedCount: t.uint64(),
    toleratingCount: t.uint64(),
    apdexScore: t.float64(),
  },
});

export type ServiceApdexTimeSeriesParams = InferParams<typeof serviceApdexTimeSeries>;
export type ServiceApdexTimeSeriesOutput = InferOutputRow<typeof serviceApdexTimeSeries>;

/**
 * Custom traces time series endpoint - flexible time-bucketed trace metrics
 */
export const customTracesTimeseries = defineEndpoint("custom_traces_timeseries", {
  description: "Flexible time-bucketed trace metrics for custom charts.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().describe("Start of time range"),
    end_time: p.dateTime().describe("End of time range"),
    bucket_seconds: p.int32().optional(60).describe("Bucket size in seconds"),
    service_name: p.string().optional().describe("Filter by service name"),
    span_name: p.string().optional().describe("Filter by span name"),
    group_by_service: p.string().optional().describe("Group by ServiceName"),
    group_by_span_name: p.string().optional().describe("Group by SpanName"),
    group_by_status_code: p.string().optional().describe("Group by StatusCode"),
    root_only: p.string().optional().describe("Filter to root spans only"),
    environments: p.string().optional().describe("Comma-separated environments filter"),
    commit_shas: p.string().optional().describe("Comma-separated commit SHA filter"),
    group_by_attribute: p.string().optional().describe("Group by SpanAttributes[key]"),
    attribute_filter_key: p.string().optional().describe("Filter where SpanAttributes[key] = value"),
    attribute_filter_value: p.string().optional().describe("Value for attribute filter"),
  },
  nodes: [
    node({
      name: "custom_traces_ts_node",
      sql: `
        SELECT
          toStartOfInterval(Timestamp, INTERVAL {{Int32(bucket_seconds, 60)}} SECOND) AS bucket,
          {% if defined(group_by_service) %}
            ServiceName
          {% elif defined(group_by_span_name) %}
            SpanName
          {% elif defined(group_by_status_code) %}
            StatusCode
          {% elif defined(group_by_attribute) %}
            SpanAttributes[{{String(group_by_attribute)}}]
          {% else %}
            'all'
          {% end %} AS groupName,
          count() AS count,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(count() > 0, countIf(StatusCode = 'Error') * 100.0 / count(), 0) AS errorRate
        FROM traces
        WHERE Timestamp >= {{DateTime(start_time)}}
          AND OrgId = {{String(org_id, "")}}
          AND Timestamp <= {{DateTime(end_time)}}
          {% if defined(service_name) %}AND ServiceName = {{String(service_name)}}{% end %}
          {% if defined(span_name) %}AND SpanName = {{String(span_name)}}{% end %}
          {% if defined(root_only) %}AND ParentSpanId = ''{% end %}
          {% if defined(environments) %}
            AND ResourceAttributes['deployment.environment'] IN splitByChar(',', {{String(environments, "")}})
          {% end %}
          {% if defined(commit_shas) %}
            AND ResourceAttributes['deployment.commit_sha'] IN splitByChar(',', {{String(commit_shas, "")}})
          {% end %}
          {% if defined(attribute_filter_key) %}
            AND SpanAttributes[{{String(attribute_filter_key)}}] = {{String(attribute_filter_value, '')}}
          {% end %}
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
      `,
    }),
  ],
  output: {
    bucket: t.dateTime(),
    groupName: t.string(),
    count: t.uint64(),
    avgDuration: t.float64(),
    p50Duration: t.float64(),
    p95Duration: t.float64(),
    p99Duration: t.float64(),
    errorRate: t.float64(),
  },
});

export type CustomTracesTimeseriesParams = InferParams<typeof customTracesTimeseries>;
export type CustomTracesTimeseriesOutput = InferOutputRow<typeof customTracesTimeseries>;

/**
 * Custom traces breakdown endpoint - flexible aggregated trace metrics by dimension
 */
export const customTracesBreakdown = defineEndpoint("custom_traces_breakdown", {
  description: "Flexible aggregated trace metrics grouped by a chosen dimension.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().describe("Start of time range"),
    end_time: p.dateTime().describe("End of time range"),
    service_name: p.string().optional().describe("Filter by service name"),
    span_name: p.string().optional().describe("Filter by span name"),
    limit: p.int32().optional(10).describe("Maximum number of results"),
    group_by_service: p.string().optional().describe("Group by ServiceName"),
    group_by_span_name: p.string().optional().describe("Group by SpanName"),
    group_by_status_code: p.string().optional().describe("Group by StatusCode"),
    group_by_http_method: p.string().optional().describe("Group by http.method"),
    root_only: p.string().optional().describe("Filter to root spans only"),
    environments: p.string().optional().describe("Comma-separated environments filter"),
    commit_shas: p.string().optional().describe("Comma-separated commit SHA filter"),
    group_by_attribute: p.string().optional().describe("Group by SpanAttributes[key]"),
    attribute_filter_key: p.string().optional().describe("Filter where SpanAttributes[key] = value"),
    attribute_filter_value: p.string().optional().describe("Value for attribute filter"),
  },
  nodes: [
    node({
      name: "custom_traces_breakdown_node",
      sql: `
        SELECT
          {% if defined(group_by_service) %}
            ServiceName
          {% elif defined(group_by_span_name) %}
            SpanName
          {% elif defined(group_by_status_code) %}
            StatusCode
          {% elif defined(group_by_http_method) %}
            SpanAttributes['http.method']
          {% elif defined(group_by_attribute) %}
            SpanAttributes[{{String(group_by_attribute)}}]
          {% else %}
            ServiceName
          {% end %} AS name,
          count() AS count,
          avg(Duration) / 1000000 AS avgDuration,
          quantile(0.5)(Duration) / 1000000 AS p50Duration,
          quantile(0.95)(Duration) / 1000000 AS p95Duration,
          quantile(0.99)(Duration) / 1000000 AS p99Duration,
          if(count() > 0, countIf(StatusCode = 'Error') * 100.0 / count(), 0) AS errorRate
        FROM traces
        WHERE Timestamp >= {{DateTime(start_time)}}
          AND OrgId = {{String(org_id, "")}}
          AND Timestamp <= {{DateTime(end_time)}}
          {% if defined(service_name) %}AND ServiceName = {{String(service_name)}}{% end %}
          {% if defined(span_name) %}AND SpanName = {{String(span_name)}}{% end %}
          {% if defined(root_only) %}AND ParentSpanId = ''{% end %}
          {% if defined(environments) %}
            AND ResourceAttributes['deployment.environment'] IN splitByChar(',', {{String(environments, "")}})
          {% end %}
          {% if defined(commit_shas) %}
            AND ResourceAttributes['deployment.commit_sha'] IN splitByChar(',', {{String(commit_shas, "")}})
          {% end %}
          {% if defined(attribute_filter_key) %}
            AND SpanAttributes[{{String(attribute_filter_key)}}] = {{String(attribute_filter_value, '')}}
          {% end %}
        GROUP BY name
        ORDER BY count DESC
        LIMIT {{Int32(limit, 10)}}
      `,
    }),
  ],
  output: {
    name: t.string(),
    count: t.uint64(),
    avgDuration: t.float64(),
    p50Duration: t.float64(),
    p95Duration: t.float64(),
    p99Duration: t.float64(),
    errorRate: t.float64(),
  },
});

export type CustomTracesBreakdownParams = InferParams<typeof customTracesBreakdown>;
export type CustomTracesBreakdownOutput = InferOutputRow<typeof customTracesBreakdown>;

/**
 * Custom logs time series endpoint - flexible time-bucketed log counts
 */
export const customLogsTimeseries = defineEndpoint("custom_logs_timeseries", {
  description: "Flexible time-bucketed log counts for custom charts.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().describe("Start of time range"),
    end_time: p.dateTime().describe("End of time range"),
    bucket_seconds: p.int32().optional(60).describe("Bucket size in seconds"),
    service_name: p.string().optional().describe("Filter by service name"),
    severity: p.string().optional().describe("Filter by severity"),
    group_by_service: p.string().optional().describe("Group by ServiceName"),
    group_by_severity: p.string().optional().describe("Group by SeverityText"),
  },
  nodes: [
    node({
      name: "custom_logs_ts_node",
      sql: `
        SELECT
          toStartOfInterval(Timestamp, INTERVAL {{Int32(bucket_seconds, 60)}} SECOND) AS bucket,
          {% if defined(group_by_service) %}
            ServiceName
          {% elif defined(group_by_severity) %}
            SeverityText
          {% else %}
            'all'
          {% end %} AS groupName,
          count() AS count
        FROM logs
        WHERE Timestamp >= {{DateTime(start_time)}}
          AND OrgId = {{String(org_id, "")}}
          AND Timestamp <= {{DateTime(end_time)}}
          {% if defined(service_name) %}AND ServiceName = {{String(service_name)}}{% end %}
          {% if defined(severity) %}AND SeverityText = {{String(severity)}}{% end %}
        GROUP BY bucket, groupName
        ORDER BY bucket ASC, groupName ASC
      `,
    }),
  ],
  output: {
    bucket: t.dateTime(),
    groupName: t.string(),
    count: t.uint64(),
  },
});

export type CustomLogsTimeseriesParams = InferParams<typeof customLogsTimeseries>;
export type CustomLogsTimeseriesOutput = InferOutputRow<typeof customLogsTimeseries>;

/**
 * Custom logs breakdown endpoint - flexible aggregated log counts by dimension
 */
export const customLogsBreakdown = defineEndpoint("custom_logs_breakdown", {
  description: "Flexible aggregated log counts grouped by a chosen dimension.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().describe("Start of time range"),
    end_time: p.dateTime().describe("End of time range"),
    service_name: p.string().optional().describe("Filter by service name"),
    severity: p.string().optional().describe("Filter by severity"),
    limit: p.int32().optional(10).describe("Maximum number of results"),
    group_by_service: p.string().optional().describe("Group by ServiceName"),
    group_by_severity: p.string().optional().describe("Group by SeverityText"),
  },
  nodes: [
    node({
      name: "custom_logs_breakdown_node",
      sql: `
        SELECT
          {% if defined(group_by_service) %}
            ServiceName
          {% elif defined(group_by_severity) %}
            SeverityText
          {% else %}
            ServiceName
          {% end %} AS name,
          count() AS count
        FROM logs
        WHERE Timestamp >= {{DateTime(start_time)}}
          AND OrgId = {{String(org_id, "")}}
          AND Timestamp <= {{DateTime(end_time)}}
          {% if defined(service_name) %}AND ServiceName = {{String(service_name)}}{% end %}
          {% if defined(severity) %}AND SeverityText = {{String(severity)}}{% end %}
        GROUP BY name
        ORDER BY count DESC
        LIMIT {{Int32(limit, 10)}}
      `,
    }),
  ],
  output: {
    name: t.string(),
    count: t.uint64(),
  },
});

export type CustomLogsBreakdownParams = InferParams<typeof customLogsBreakdown>;
export type CustomLogsBreakdownOutput = InferOutputRow<typeof customLogsBreakdown>;

/**
 * Custom metrics breakdown endpoint - aggregated metric values grouped by ServiceName
 */
export const customMetricsBreakdown = defineEndpoint("custom_metrics_breakdown", {
  description: "Aggregated metric values grouped by ServiceName across all metric types.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    metric_name: p.string().describe("Metric name (required)"),
    start_time: p.dateTime().describe("Start of time range"),
    end_time: p.dateTime().describe("End of time range"),
    metric_type: p.string().optional().describe("Filter by metric type (sum, gauge, histogram, exponential_histogram)"),
    limit: p.int32().optional(10).describe("Maximum number of results"),
  },
  nodes: [
    node({
      name: "sum_breakdown",
      sql: `
        SELECT
          ServiceName AS name,
          avg(Value) AS avgValue,
          sum(Value) AS sumValue,
          count() AS count
        FROM metrics_sum
        WHERE MetricName = {{String(metric_name)}}
          AND OrgId = {{String(org_id, "")}}
          AND TimeUnix >= {{DateTime(start_time)}}
          AND TimeUnix <= {{DateTime(end_time)}}
        GROUP BY ServiceName
      `,
    }),
    node({
      name: "gauge_breakdown",
      sql: `
        SELECT
          ServiceName AS name,
          avg(Value) AS avgValue,
          sum(Value) AS sumValue,
          count() AS count
        FROM metrics_gauge
        WHERE MetricName = {{String(metric_name)}}
          AND OrgId = {{String(org_id, "")}}
          AND TimeUnix >= {{DateTime(start_time)}}
          AND TimeUnix <= {{DateTime(end_time)}}
        GROUP BY ServiceName
      `,
    }),
    node({
      name: "histogram_breakdown",
      sql: `
        SELECT
          ServiceName AS name,
          if(sum(Count) > 0, sum(Sum) / sum(Count), 0) AS avgValue,
          sum(Sum) AS sumValue,
          sum(Count) AS count
        FROM metrics_histogram
        WHERE MetricName = {{String(metric_name)}}
          AND OrgId = {{String(org_id, "")}}
          AND TimeUnix >= {{DateTime(start_time)}}
          AND TimeUnix <= {{DateTime(end_time)}}
        GROUP BY ServiceName
      `,
    }),
    node({
      name: "exp_histogram_breakdown",
      sql: `
        SELECT
          ServiceName AS name,
          if(sum(Count) > 0, sum(Sum) / sum(Count), 0) AS avgValue,
          sum(Sum) AS sumValue,
          sum(Count) AS count
        FROM metrics_exponential_histogram
        WHERE MetricName = {{String(metric_name)}}
          AND OrgId = {{String(org_id, "")}}
          AND TimeUnix >= {{DateTime(start_time)}}
          AND TimeUnix <= {{DateTime(end_time)}}
        GROUP BY ServiceName
      `,
    }),
    node({
      name: "combined_breakdown",
      sql: `
        SELECT name, avgValue, sumValue, count
        FROM (
          {% if not defined(metric_type) or metric_type == 'sum' %}
            SELECT * FROM sum_breakdown
          {% else %}
            SELECT name, avgValue, sumValue, count FROM sum_breakdown WHERE 1=0
          {% end %}
          UNION ALL
          {% if not defined(metric_type) or metric_type == 'gauge' %}
            SELECT * FROM gauge_breakdown
          {% else %}
            SELECT name, avgValue, sumValue, count FROM gauge_breakdown WHERE 1=0
          {% end %}
          UNION ALL
          {% if not defined(metric_type) or metric_type == 'histogram' %}
            SELECT * FROM histogram_breakdown
          {% else %}
            SELECT name, avgValue, sumValue, count FROM histogram_breakdown WHERE 1=0
          {% end %}
          UNION ALL
          {% if not defined(metric_type) or metric_type == 'exponential_histogram' %}
            SELECT * FROM exp_histogram_breakdown
          {% else %}
            SELECT name, avgValue, sumValue, count FROM exp_histogram_breakdown WHERE 1=0
          {% end %}
        )
        ORDER BY count DESC
        LIMIT {{Int32(limit, 10)}}
      `,
    }),
  ],
  output: {
    name: t.string(),
    avgValue: t.float64(),
    sumValue: t.float64(),
    count: t.uint64(),
  },
});

export type CustomMetricsBreakdownParams = InferParams<typeof customMetricsBreakdown>;
export type CustomMetricsBreakdownOutput = InferOutputRow<typeof customMetricsBreakdown>;

/**
 * Service dependencies endpoint - derive service-to-service edges from trace data
 */
export const serviceDependencies = defineEndpoint("service_dependencies", {
  description: "Get service-to-service dependency edges derived from span parent-child relationships.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().optional().describe("Start of time range"),
    end_time: p.dateTime().optional().describe("End of time range"),
    deployment_env: p.string().optional().describe("Filter by deployment environment"),
  },
  nodes: [
    node({
      name: "peer_service_edges",
      sql: `
        SELECT
          ServiceName AS sourceService,
          SpanAttributes['peer.service'] AS targetService,
          count() AS callCount,
          countIf(StatusCode = 'Error') AS errorCount,
          avg(Duration / 1000000) AS avgDurationMs,
          quantile(0.95)(Duration / 1000000) AS p95DurationMs,
          countIf(TraceState LIKE '%th:%') AS sampledSpanCount,
          countIf(TraceState = '' OR TraceState NOT LIKE '%th:%') AS unsampledSpanCount,
          anyIf(extract(TraceState, 'th:([0-9a-f]+)'), TraceState LIKE '%th:%') AS dominantThreshold
        FROM traces
        WHERE OrgId = {{String(org_id, "")}}
          AND SpanKind = 'Client'
          AND SpanAttributes['peer.service'] != ''
        {% if defined(start_time) %}
          AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
        {% end %}
        {% if defined(end_time) %}
          AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
        {% end %}
        {% if defined(deployment_env) %}
          AND ResourceAttributes['deployment.environment'] = {{String(deployment_env)}}
        {% end %}
        GROUP BY sourceService, targetService
      `,
    }),
    node({
      name: "join_edges",
      sql: `
        SELECT
          p.ServiceName AS sourceService,
          c.ServiceName AS targetService,
          count() AS callCount,
          countIf(c.StatusCode = 'Error') AS errorCount,
          avg(c.Duration / 1000000) AS avgDurationMs,
          quantile(0.95)(c.Duration / 1000000) AS p95DurationMs,
          countIf(c.TraceState LIKE '%th:%') AS sampledSpanCount,
          countIf(c.TraceState = '' OR c.TraceState NOT LIKE '%th:%') AS unsampledSpanCount,
          anyIf(extract(c.TraceState, 'th:([0-9a-f]+)'), c.TraceState LIKE '%th:%') AS dominantThreshold
        FROM (
          SELECT TraceId, SpanId, ServiceName
          FROM traces
          WHERE OrgId = {{String(org_id, "")}}
            AND SpanKind IN ('Client', 'Producer')
            AND SpanAttributes['peer.service'] = ''
          {% if defined(start_time) %}
            AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
          {% end %}
          {% if defined(end_time) %}
            AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
          {% end %}
          {% if defined(deployment_env) %}
            AND ResourceAttributes['deployment.environment'] = {{String(deployment_env)}}
          {% end %}
        ) AS p
        INNER JOIN (
          SELECT TraceId, ParentSpanId, ServiceName, Duration, StatusCode, TraceState
          FROM traces
          WHERE OrgId = {{String(org_id, "")}}
            AND ParentSpanId != ''
          {% if defined(start_time) %}
            AND Timestamp >= {{DateTime(start_time, "2023-01-01 00:00:00")}}
          {% end %}
          {% if defined(end_time) %}
            AND Timestamp <= {{DateTime(end_time, "2099-12-31 23:59:59")}}
          {% end %}
          {% if defined(deployment_env) %}
            AND ResourceAttributes['deployment.environment'] = {{String(deployment_env)}}
          {% end %}
        ) AS c
        ON p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId
        WHERE p.ServiceName != c.ServiceName
        GROUP BY sourceService, targetService
      `,
    }),
    node({
      name: "merged_edges",
      sql: `
        SELECT
          sourceService,
          targetService,
          sum(callCount) AS callCount,
          sum(errorCount) AS errorCount,
          avg(avgDurationMs) AS avgDurationMs,
          max(p95DurationMs) AS p95DurationMs,
          sum(sampledSpanCount) AS sampledSpanCount,
          sum(unsampledSpanCount) AS unsampledSpanCount,
          any(dominantThreshold) AS dominantThreshold
        FROM (
          SELECT * FROM peer_service_edges
          UNION ALL
          SELECT * FROM join_edges
        )
        GROUP BY sourceService, targetService
        ORDER BY callCount DESC
        LIMIT 200
      `,
    }),
  ],
  output: {
    sourceService: t.string(),
    targetService: t.string(),
    callCount: t.uint64(),
    errorCount: t.uint64(),
    avgDurationMs: t.float64(),
    p95DurationMs: t.float64(),
    sampledSpanCount: t.uint64(),
    unsampledSpanCount: t.uint64(),
    dominantThreshold: t.string(),
  },
});

export type ServiceDependenciesParams = InferParams<typeof serviceDependencies>;
export type ServiceDependenciesOutput = InferOutputRow<typeof serviceDependencies>;

/**
 * Span attribute keys endpoint - returns distinct span attribute key names
 */
export const spanAttributeKeys = defineEndpoint("span_attribute_keys", {
  description: "List distinct span attribute keys with usage counts.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().describe("Start of time range"),
    end_time: p.dateTime().describe("End of time range"),
    limit: p.int32().optional(200).describe("Maximum number of keys to return"),
  },
  nodes: [
    node({
      name: "span_attribute_keys_node",
      sql: `
        SELECT
          arrayJoin(mapKeys(SpanAttributes)) AS attributeKey,
          count() AS usageCount
        FROM traces
        WHERE OrgId = {{String(org_id, "")}}
          AND Timestamp >= {{DateTime(start_time)}}
          AND Timestamp <= {{DateTime(end_time)}}
          AND SpanAttributes != map()
        GROUP BY attributeKey
        ORDER BY usageCount DESC
        LIMIT {{Int32(limit, 200)}}
      `,
    }),
  ],
  output: {
    attributeKey: t.string(),
    usageCount: t.uint64(),
  },
});

export type SpanAttributeKeysParams = InferParams<typeof spanAttributeKeys>;
export type SpanAttributeKeysOutput = InferOutputRow<typeof spanAttributeKeys>;

/**
 * Span attribute values endpoint - returns distinct values for a specific attribute key
 */
export const spanAttributeValues = defineEndpoint("span_attribute_values", {
  description: "List distinct values for a specific span attribute key.",
  params: {
    org_id: p.string().optional().describe("Organization ID"),
    start_time: p.dateTime().describe("Start of time range"),
    end_time: p.dateTime().describe("End of time range"),
    attribute_key: p.string().describe("The attribute key to get values for"),
    limit: p.int32().optional(50).describe("Maximum number of values to return"),
  },
  nodes: [
    node({
      name: "span_attribute_values_node",
      sql: `
        SELECT
          SpanAttributes[{{String(attribute_key)}}] AS attributeValue,
          count() AS usageCount
        FROM traces
        WHERE OrgId = {{String(org_id, "")}}
          AND Timestamp >= {{DateTime(start_time)}}
          AND Timestamp <= {{DateTime(end_time)}}
          AND SpanAttributes[{{String(attribute_key)}}] != ''
        GROUP BY attributeValue
        ORDER BY usageCount DESC
        LIMIT {{Int32(limit, 50)}}
      `,
    }),
  ],
  output: {
    attributeValue: t.string(),
    usageCount: t.uint64(),
  },
});

export type SpanAttributeValuesParams = InferParams<typeof spanAttributeValues>;
export type SpanAttributeValuesOutput = InferOutputRow<typeof spanAttributeValues>;
