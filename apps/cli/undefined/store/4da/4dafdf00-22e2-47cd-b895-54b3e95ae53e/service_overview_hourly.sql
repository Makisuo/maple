ATTACH TABLE _ UUID 'dde1a981-6e38-4422-a8a5-59c6866d8a95'
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `DeploymentEnv` LowCardinality(String),
    `ServiceNamespace` LowCardinality(String),
    `CommitSha` LowCardinality(String),
    `SpanCount` SimpleAggregateFunction(sum, UInt64),
    `EstimatedSpanCount` SimpleAggregateFunction(sum, Float64),
    `ErrorCount` SimpleAggregateFunction(sum, UInt64),
    `EstimatedErrorCount` SimpleAggregateFunction(sum, Float64),
    `DurationSum` SimpleAggregateFunction(sum, Float64),
    `DurationQuantiles` AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), UInt64),
    `FirstSeen` SimpleAggregateFunction(min, DateTime),
    `ApdexSatisfiedCount` SimpleAggregateFunction(sum, UInt64),
    `ApdexToleratingCount` SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(Hour)
ORDER BY (OrgId, ServiceName, Hour, DeploymentEnv, ServiceNamespace, CommitSha)
TTL toDate(Hour) + toIntervalDay(365)
SETTINGS index_granularity = 8192
