ATTACH MATERIALIZED VIEW _ UUID 'c8cf50ec-2b89-404d-a29a-689894d41db4' TO default.service_overview_spans
(
    `OrgId` LowCardinality(String),
    `Timestamp` DateTime,
    `ServiceName` LowCardinality(String),
    `Duration` UInt64,
    `StatusCode` LowCardinality(String),
    `TraceState` String,
    `DeploymentEnv` String,
    `CommitSha` String,
    `SampleRate` Float64,
    `ServiceNamespace` String
)
AS SELECT
    OrgId,
    toDateTime(Timestamp) AS Timestamp,
    ServiceName,
    Duration,
    StatusCode,
    TraceState,
    ResourceAttributes['deployment.environment'] AS DeploymentEnv,
    ResourceAttributes['deployment.commit_sha'] AS CommitSha,
    SampleRate,
    ResourceAttributes['service.namespace'] AS ServiceNamespace
FROM default.traces
WHERE (SpanKind IN ('Server', 'Consumer')) OR (ParentSpanId = '')
