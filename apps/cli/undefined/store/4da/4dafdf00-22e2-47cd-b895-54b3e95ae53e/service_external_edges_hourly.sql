ATTACH TABLE _ UUID '257d4085-f0f5-4acb-b212-2405b01d30b4'
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `TargetType` LowCardinality(String),
    `TargetSystem` LowCardinality(String),
    `TargetName` String,
    `DeploymentEnv` LowCardinality(String),
    `CallCount` SimpleAggregateFunction(sum, UInt64),
    `ErrorCount` SimpleAggregateFunction(sum, UInt64),
    `DurationSumMs` SimpleAggregateFunction(sum, Float64),
    `MaxDurationMs` SimpleAggregateFunction(max, Float64),
    `SampleRateSum` SimpleAggregateFunction(sum, Float64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, Hour, DeploymentEnv, ServiceName, TargetType, TargetSystem, TargetName)
TTL toDate(Hour) + toIntervalDay(365)
SETTINGS index_granularity = 8192
