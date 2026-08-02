ATTACH MATERIALIZED VIEW _ UUID '367e1f16-7308-45f5-8e0d-cd66523fef59' TO default.service_usage
(
    `OrgId` LowCardinality(String),
    `ServiceName` LowCardinality(String),
    `Hour` DateTime,
    `LogCount` UInt8,
    `LogSizeBytes` UInt8,
    `TraceCount` UInt8,
    `TraceSizeBytes` UInt8,
    `SumMetricCount` UInt64,
    `SumMetricSizeBytes` UInt64,
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
FROM default.metrics_sum
GROUP BY
    OrgId,
    ServiceName,
    Hour
