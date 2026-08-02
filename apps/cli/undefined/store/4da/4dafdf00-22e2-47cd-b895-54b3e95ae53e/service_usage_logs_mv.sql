ATTACH MATERIALIZED VIEW _ UUID '81735aa8-b5bc-44e2-8c7e-888ec6a1492d' TO default.service_usage
(
    `OrgId` LowCardinality(String),
    `ServiceName` LowCardinality(String),
    `Hour` DateTime,
    `LogCount` UInt64,
    `LogSizeBytes` UInt64,
    `TraceCount` UInt8,
    `TraceSizeBytes` UInt8,
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
FROM default.logs
GROUP BY
    OrgId,
    ServiceName,
    Hour
