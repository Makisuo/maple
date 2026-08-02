ATTACH TABLE _ UUID 'cbca234b-9a38-4311-8898-f8f8995e022b'
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `MetricType` LowCardinality(String),
    `ServiceName` LowCardinality(String),
    `MetricName` LowCardinality(String),
    `MetricDescription` SimpleAggregateFunction(anyLast, String),
    `MetricUnit` SimpleAggregateFunction(anyLast, String),
    `IsMonotonic` SimpleAggregateFunction(anyLast, UInt8),
    `DataPointCount` SimpleAggregateFunction(sum, UInt64),
    `FirstSeen` SimpleAggregateFunction(min, DateTime),
    `LastSeen` SimpleAggregateFunction(max, DateTime)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, MetricType, ServiceName, MetricName, Hour)
TTL Hour + toIntervalDay(90)
SETTINGS index_granularity = 8192
