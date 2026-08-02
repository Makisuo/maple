ATTACH MATERIALIZED VIEW _ UUID '03033815-85cf-4f7d-b5d9-ccd406114648' TO default.service_map_children
(
    `OrgId` LowCardinality(String),
    `Timestamp` DateTime,
    `TraceId` String,
    `ParentSpanId` String,
    `ServiceName` LowCardinality(String),
    `SpanKind` LowCardinality(String),
    `Duration` UInt64,
    `StatusCode` LowCardinality(String),
    `TraceState` String,
    `DeploymentEnv` String
)
AS SELECT
    OrgId,
    toDateTime(Timestamp) AS Timestamp,
    TraceId,
    ParentSpanId,
    ServiceName,
    SpanKind,
    Duration,
    StatusCode,
    TraceState,
    ResourceAttributes['deployment.environment'] AS DeploymentEnv
FROM default.traces
WHERE (SpanKind IN ('Server', 'Consumer')) AND (ParentSpanId != '')
