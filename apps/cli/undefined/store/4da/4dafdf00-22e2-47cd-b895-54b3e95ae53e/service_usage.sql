ATTACH TABLE _ UUID '152ab9c9-5146-43bd-ab8f-4b4b507036d3'
(
    `OrgId` LowCardinality(String),
    `ServiceName` LowCardinality(String),
    `Hour` DateTime,
    `LogCount` UInt64,
    `LogSizeBytes` UInt64,
    `TraceCount` UInt64,
    `TraceSizeBytes` UInt64,
    `SumMetricCount` UInt64,
    `SumMetricSizeBytes` UInt64,
    `GaugeMetricCount` UInt64,
    `GaugeMetricSizeBytes` UInt64,
    `HistogramMetricCount` UInt64,
    `HistogramMetricSizeBytes` UInt64,
    `ExpHistogramMetricCount` UInt64,
    `ExpHistogramMetricSizeBytes` UInt64
)
ENGINE = SummingMergeTree
ORDER BY (OrgId, ServiceName, Hour)
TTL Hour + toIntervalDay(365)
SETTINGS index_granularity = 8192
