ATTACH TABLE _ UUID 'b503fd23-f9f3-43af-99b6-6b118c2d1757'
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `MetricName` LowCardinality(String),
    `SpanKind` LowCardinality(String),
    `AttrFingerprint` UInt64,
    `ResourceFingerprint` UInt64,
    `StartTimeUnix` DateTime64(9),
    `LastValue` AggregateFunction(argMax, Float64, DateTime64(9))
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, Hour, ServiceName, MetricName, SpanKind, AttrFingerprint, ResourceFingerprint, StartTimeUnix)
TTL toDate(Hour) + toIntervalDay(90)
SETTINGS index_granularity = 8192
