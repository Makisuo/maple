ATTACH MATERIALIZED VIEW _ UUID '17f4bafb-5af4-46e7-ba6c-cc563b579d33' TO default.service_overview_hourly
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `DeploymentEnv` String,
    `ServiceNamespace` String,
    `CommitSha` String,
    `SpanCount` UInt64,
    `EstimatedSpanCount` Float64,
    `ErrorCount` UInt64,
    `EstimatedErrorCount` Float64,
    `DurationSum` Float64,
    `DurationQuantiles` AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), UInt64),
    `FirstSeen` DateTime,
    `ApdexSatisfiedCount` UInt64,
    `ApdexToleratingCount` UInt64
)
AS SELECT
    OrgId,
    toStartOfHour(toDateTime(Timestamp)) AS Hour,
    ServiceName,
    ResourceAttributes['deployment.environment'] AS DeploymentEnv,
    ResourceAttributes['service.namespace'] AS ServiceNamespace,
    ResourceAttributes['deployment.commit_sha'] AS CommitSha,
    count() AS SpanCount,
    sum(SampleRate) AS EstimatedSpanCount,
    countIf(StatusCode = 'Error') AS ErrorCount,
    sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
    sum(toFloat64(Duration)) AS DurationSum,
    quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS DurationQuantiles,
    min(toDateTime(Timestamp)) AS FirstSeen,
    countIf((StatusCode != 'Error') AND (Duration < 500000000)) AS ApdexSatisfiedCount,
    countIf((StatusCode != 'Error') AND (Duration >= 500000000) AND (Duration < 2000000000)) AS ApdexToleratingCount
FROM default.traces
WHERE (SpanKind IN ('Server', 'Consumer')) OR (ParentSpanId = '')
GROUP BY
    OrgId,
    Hour,
    ServiceName,
    DeploymentEnv,
    ServiceNamespace,
    CommitSha
