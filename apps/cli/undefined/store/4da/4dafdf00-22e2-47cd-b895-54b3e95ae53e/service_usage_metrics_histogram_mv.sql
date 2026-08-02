ATTACH MATERIALIZED VIEW _ UUID '3856550b-a689-478a-b8bf-87fe7be81f72' TO default.service_usage
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
    `HistogramMetricCount` UInt64,
    `HistogramMetricSizeBytes` UInt64,
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
    0 AS GaugeMetricCount,
    0 AS GaugeMetricSizeBytes,
    count() AS HistogramMetricCount,
    count() * 250 AS HistogramMetricSizeBytes,
    0 AS ExpHistogramMetricCount,
    0 AS ExpHistogramMetricSizeBytes
FROM default.metrics_histogram
GROUP BY
    OrgId,
    ServiceName,
    Hour
