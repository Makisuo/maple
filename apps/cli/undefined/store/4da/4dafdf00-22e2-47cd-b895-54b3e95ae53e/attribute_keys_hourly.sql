ATTACH TABLE _ UUID 'c84d7b79-0120-47db-8ba3-397903d6f1e5'
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `AttributeKey` LowCardinality(String),
    `AttributeScope` LowCardinality(String),
    `UsageCount` SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, AttributeScope, Hour, AttributeKey)
TTL Hour + toIntervalDay(90)
SETTINGS index_granularity = 8192
