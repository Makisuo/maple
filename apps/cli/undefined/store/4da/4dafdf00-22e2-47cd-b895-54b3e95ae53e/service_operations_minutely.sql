ATTACH TABLE _ UUID '90b77c1e-3c99-4ccf-a397-2f0b39ebdccd'
(
    `OrgId` LowCardinality(String),
    `Minute` DateTime,
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
PARTITION BY toDate(Minute)
ORDER BY (OrgId, ServiceName, DeploymentEnv, Minute, SpanName)
TTL toDate(Minute) + toIntervalDay(90)
SETTINGS index_granularity = 8192
