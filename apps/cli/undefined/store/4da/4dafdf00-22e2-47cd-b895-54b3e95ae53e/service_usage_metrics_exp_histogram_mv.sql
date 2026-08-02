ATTACH MATERIALIZED VIEW _ UUID '731b7be8-12ee-4a31-b3a2-3863a29b5a8c' TO default.service_usage
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
    `GaugeMetricCount` UInt8,
    `GaugeMetricSizeBytes` UInt8,
    `HistogramMetricCount` UInt8,
    `HistogramMetricSizeBytes` UInt8,
    `ExpHistogramMetricCount` UInt64,
    `ExpHistogramMetricSizeBytes` UInt64
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
    0 AS GaugeMetricCount,
    0 AS GaugeMetricSizeBytes,
    0 AS HistogramMetricCount,
    0 AS HistogramMetricSizeBytes,
    count() AS ExpHistogramMetricCount,
    count() * 300 AS ExpHistogramMetricSizeBytes
FROM default.metrics_exponential_histogram
GROUP BY
    OrgId,
    ServiceName,
    Hour
