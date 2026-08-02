ATTACH TABLE _ UUID '7e6e2368-2584-44ee-9a09-5ba1325bb4e4'
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `AttributeKey` LowCardinality(String),
    `AttributeValue` String,
    `AttributeScope` LowCardinality(String),
    `UsageCount` SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, AttributeScope, AttributeKey, Hour, AttributeValue)
TTL Hour + toIntervalDay(90)
SETTINGS index_granularity = 8192
