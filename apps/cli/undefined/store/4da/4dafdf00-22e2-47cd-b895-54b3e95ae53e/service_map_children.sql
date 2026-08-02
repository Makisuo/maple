ATTACH TABLE _ UUID 'e4239322-4806-4bb4-b5b2-110411695bde'
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
    `DeploymentEnv` LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, TraceId, ParentSpanId, Timestamp)
TTL Timestamp + toIntervalDay(30)
SETTINGS index_granularity = 8192
