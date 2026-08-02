ATTACH MATERIALIZED VIEW _ UUID '8ae4b8de-76c3-4a7a-90de-71679d3431cb' TO default.service_usage
(
    `OrgId` LowCardinality(String),
    `ServiceName` LowCardinality(String),
    `Hour` DateTime,
    `LogCount` UInt8,
    `LogSizeBytes` UInt8,
    `TraceCount` UInt64,
    `TraceSizeBytes` UInt64,
    `SumMetricCount` UInt8,
    `SumMetricSizeBytes` UInt8,
    `GaugeMetricCount` UInt8,
    `GaugeMetricSizeBytes` UInt8,
    `HistogramMetricCount` UInt8,
    `HistogramMetricSizeBytes` UInt8,
    `ExpHistogramMetricCount` UInt8,
    `ExpHistogramMetricSizeBytes` UInt8
)
AS SELECT
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
FROM default.traces
GROUP BY
    OrgId,
    ServiceName,
    Hour
