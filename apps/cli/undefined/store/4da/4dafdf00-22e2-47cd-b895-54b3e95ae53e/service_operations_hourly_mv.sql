ATTACH MATERIALIZED VIEW _ UUID 'c5da757f-e1b8-443d-9399-f28db8fd78fa' TO default.service_operations_hourly
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `DeploymentEnv` LowCardinality(String),
    `SpanName` String,
    `SpanCount` UInt64,
    `EstimatedSpanCount` Float64,
    `ErrorCount` UInt64,
    `EstimatedErrorCount` Float64,
    `DurationSum` Float64,
    `DurationQuantiles` AggregateFunction(quantilesTDigest(0.5, 0.95), UInt64)
)
AS SELECT
    OrgId,
    toStartOfHour(Minute) AS Hour,
    ServiceName,
    DeploymentEnv,
    SpanName,
    sum(SpanCount) AS SpanCount,
    sum(EstimatedSpanCount) AS EstimatedSpanCount,
    sum(ErrorCount) AS ErrorCount,
    sum(EstimatedErrorCount) AS EstimatedErrorCount,
    sum(DurationSum) AS DurationSum,
    quantilesTDigestMergeState(0.5, 0.95)(DurationQuantiles) AS DurationQuantiles
FROM default.service_operations_minutely
GROUP BY
    OrgId,
    Hour,
    ServiceName,
    DeploymentEnv,
    SpanName
