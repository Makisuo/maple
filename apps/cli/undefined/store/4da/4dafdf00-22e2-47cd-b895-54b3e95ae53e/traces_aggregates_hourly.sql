ATTACH TABLE _ UUID '5ab600e4-915b-409e-92d4-c28b8256c1c0'
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `SpanName` LowCardinality(String),
    `SpanKind` LowCardinality(String),
    `StatusCode` LowCardinality(String),
    `IsEntryPoint` UInt8,
    `DeploymentEnv` LowCardinality(String),
    `WeightedCount` SimpleAggregateFunction(sum, Float64),
    `WeightedDurationSum` SimpleAggregateFunction(sum, Float64),
    `WeightedErrorCount` SimpleAggregateFunction(sum, Float64),
    `DurationQuantiles` AggregateFunction(quantilesTDigestWeighted(0.5, 0.95, 0.99), UInt64, UInt32),
    `DurationMin` SimpleAggregateFunction(min, UInt64),
    `DurationMax` SimpleAggregateFunction(max, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, Hour, ServiceName, SpanName, SpanKind, StatusCode, IsEntryPoint, DeploymentEnv)
TTL toDate(Hour) + toIntervalDay(365)
SETTINGS index_granularity = 8192
