ATTACH TABLE _ UUID '1bcf7fa9-eccc-48d9-bb07-ac843aec1a6d'
(
    `OrgId` LowCardinality(String),
    `TraceId` String,
    `Timestamp` DateTime,
    `ServiceName` LowCardinality(String),
    `SpanName` String,
    `SpanKind` LowCardinality(String),
    `Duration` UInt64,
    `StatusCode` LowCardinality(String),
    `HttpMethod` LowCardinality(String),
    `HttpRoute` String,
    `HttpStatusCode` LowCardinality(String),
    `DeploymentEnv` LowCardinality(String),
    `HasError` UInt8,
    `TraceState` String,
    `ServiceNamespace` LowCardinality(String),
    INDEX idx_service_namespace ServiceNamespace TYPE set(1000) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, Timestamp, TraceId)
TTL Timestamp + toIntervalDay(30)
SETTINGS index_granularity = 8192
