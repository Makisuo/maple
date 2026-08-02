ATTACH MATERIALIZED VIEW _ UUID 'cdd3e44c-06a6-46ae-92db-aa8a4713707f' TO default.service_map_spans
(
    `OrgId` LowCardinality(String),
    `Timestamp` DateTime,
    `TraceId` String,
    `SpanId` String,
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
    SpanId,
    ParentSpanId,
    ServiceName,
    SpanKind,
    Duration,
    StatusCode,
    TraceState,
    ResourceAttributes['deployment.environment'] AS DeploymentEnv
FROM default.traces
WHERE SpanKind IN ('Client', 'Producer', 'Server', 'Consumer')
