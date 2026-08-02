ATTACH TABLE _ UUID '672953b5-d1cb-4c18-9a97-8c28f4057844'
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `SourceService` LowCardinality(String),
    `TargetService` String,
    `DeploymentEnv` LowCardinality(String),
    `CallCount` SimpleAggregateFunction(sum, UInt64),
    `ErrorCount` SimpleAggregateFunction(sum, UInt64),
    `DurationSumMs` SimpleAggregateFunction(sum, Float64),
    `MaxDurationMs` SimpleAggregateFunction(max, Float64),
    `SampledSpanCount` SimpleAggregateFunction(sum, UInt64),
    `UnsampledSpanCount` SimpleAggregateFunction(sum, UInt64),
    `SampleRateSum` SimpleAggregateFunction(sum, Float64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, Hour, DeploymentEnv, SourceService, TargetService)
TTL toDate(Hour) + toIntervalDay(365)
SETTINGS index_granularity = 8192
