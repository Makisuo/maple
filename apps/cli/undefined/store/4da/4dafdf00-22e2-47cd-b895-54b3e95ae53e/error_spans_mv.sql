ATTACH MATERIALIZED VIEW _ UUID '74fcfc54-976f-4b2e-a2b0-aff565dd44ef' TO default.error_spans
(
    `OrgId` LowCardinality(String),
    `Timestamp` DateTime,
    `TraceId` String,
    `SpanId` String,
    `ParentSpanId` String,
    `ServiceName` LowCardinality(String),
    `StatusMessage` String,
    `Duration` UInt64,
    `DeploymentEnv` String
)
AS SELECT
    OrgId,
    toDateTime(Timestamp) AS Timestamp,
    TraceId,
    SpanId,
    ParentSpanId,
    ServiceName,
    StatusMessage,
    Duration,
    ResourceAttributes['deployment.environment'] AS DeploymentEnv
FROM default.traces
WHERE StatusCode = 'Error'
