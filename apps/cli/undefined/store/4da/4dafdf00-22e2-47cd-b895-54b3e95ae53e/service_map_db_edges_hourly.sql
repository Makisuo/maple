ATTACH TABLE _ UUID 'a1ffb892-67b8-4468-985d-8ade331af7fc'
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `DbSystem` LowCardinality(String),
    `DeploymentEnv` LowCardinality(String),
    `CallCount` SimpleAggregateFunction(sum, UInt64),
    `ErrorCount` SimpleAggregateFunction(sum, UInt64),
    `DurationSumMs` SimpleAggregateFunction(sum, Float64),
    `MaxDurationMs` SimpleAggregateFunction(max, Float64),
    `SampledSpanCount` SimpleAggregateFunction(sum, UInt64),
    `UnsampledSpanCount` SimpleAggregateFunction(sum, UInt64),
    `SampleRateSum` SimpleAggregateFunction(sum, Float64),
    `DbNamespace` LowCardinality(String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, Hour, DeploymentEnv, ServiceName, DbSystem, DbNamespace)
TTL toDate(Hour) + toIntervalDay(365)
SETTINGS index_granularity = 8192
