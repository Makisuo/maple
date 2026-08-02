ATTACH TABLE _ UUID 'b8f2ff41-3b01-45e9-a6d2-dc07388625be'
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `DbSystem` LowCardinality(String),
    `DeploymentEnv` LowCardinality(String),
    `QueryKey` String,
    `QueryLabel` SimpleAggregateFunction(any, String),
    `SampleStatement` SimpleAggregateFunction(any, String),
    `CallCount` SimpleAggregateFunction(sum, UInt64),
    `ErrorCount` SimpleAggregateFunction(sum, UInt64),
    `EstimatedCount` SimpleAggregateFunction(sum, Float64),
    `EstimatedErrorCount` SimpleAggregateFunction(sum, Float64),
    `WeightedDurationSumMs` SimpleAggregateFunction(sum, Float64),
    `DurationQuantiles` AggregateFunction(quantilesTDigestWeighted(0.5, 0.95), UInt64, UInt32),
    `DbNamespace` LowCardinality(String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, Hour, DeploymentEnv, ServiceName, DbSystem, DbNamespace, QueryKey)
TTL toDate(Hour) + toIntervalDay(365)
SETTINGS index_granularity = 8192
