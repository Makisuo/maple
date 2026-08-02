ATTACH MATERIALIZED VIEW _ UUID '178977c4-cc9a-4ea5-a2a1-d50f3f5bc400' TO default.traces_aggregates_hourly
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `SpanName` LowCardinality(String),
    `SpanKind` LowCardinality(String),
    `StatusCode` LowCardinality(String),
    `IsEntryPoint` UInt8,
    `DeploymentEnv` String,
    `WeightedCount` Float64,
    `WeightedDurationSum` Float64,
    `WeightedErrorCount` Float64,
    `DurationQuantiles` AggregateFunction(quantilesTDigestWeighted(0.5, 0.95, 0.99), UInt64, UInt32),
    `DurationMin` UInt64,
    `DurationMax` UInt64
)
AS SELECT
    OrgId,
    toStartOfHour(toDateTime(Timestamp)) AS Hour,
    ServiceName,
    SpanName,
    SpanKind,
    StatusCode,
    IsEntryPoint,
    ResourceAttributes['deployment.environment'] AS DeploymentEnv,
    sum(SampleRate) AS WeightedCount,
    sum(toFloat64(Duration) * SampleRate) AS WeightedDurationSum,
    sumIf(SampleRate, StatusCode = 'Error') AS WeightedErrorCount,
    quantilesTDigestWeightedState(0.5, 0.95, 0.99)(Duration, toUInt32(SampleRate)) AS DurationQuantiles,
    min(Duration) AS DurationMin,
    max(Duration) AS DurationMax
FROM default.traces
GROUP BY
    OrgId,
    Hour,
    ServiceName,
    SpanName,
    SpanKind,
    StatusCode,
    IsEntryPoint,
    DeploymentEnv
