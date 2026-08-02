ATTACH MATERIALIZED VIEW _ UUID '248ea999-04cf-472e-a03c-6a18b4c680ce' TO default.service_usage
(
    `OrgId` LowCardinality(String),
    `ServiceName` LowCardinality(String),
    `Hour` DateTime,
    `LogCount` UInt8,
    `LogSizeBytes` UInt8,
    `TraceCount` UInt8,
    `TraceSizeBytes` UInt8,
    `SumMetricCount` UInt8,
    `SumMetricSizeBytes` UInt8,
    `GaugeMetricCount` UInt64,
    `GaugeMetricSizeBytes` UInt64,
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
    0 AS SumMetricCount,
    0 AS SumMetricSizeBytes,
    count() AS GaugeMetricCount,
    count() * 150 AS GaugeMetricSizeBytes,
    0 AS HistogramMetricCount,
    0 AS HistogramMetricSizeBytes,
    0 AS ExpHistogramMetricCount,
    0 AS ExpHistogramMetricSizeBytes
FROM default.metrics_gauge
GROUP BY
    OrgId,
    ServiceName,
    Hour
