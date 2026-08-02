ATTACH TABLE _ UUID '997a6169-c208-48c7-b5dc-fc2742703468'
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `DeploymentEnv` LowCardinality(String),
    `SpanName` String,
    `SpanCount` SimpleAggregateFunction(sum, UInt64),
    `EstimatedSpanCount` SimpleAggregateFunction(sum, Float64),
    `ErrorCount` SimpleAggregateFunction(sum, UInt64),
    `EstimatedErrorCount` SimpleAggregateFunction(sum, Float64),
    `DurationSum` SimpleAggregateFunction(sum, Float64),
    `DurationQuantiles` AggregateFunction(quantilesTDigest(0.5, 0.95), UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(Hour)
ORDER BY (OrgId, ServiceName, DeploymentEnv, Hour, SpanName)
TTL toDate(Hour) + toIntervalDay(365)
SETTINGS index_granularity = 8192
