ATTACH TABLE _ UUID '86fd6d4d-12d3-471e-8126-45560c0dd349'
(
    `OrgId` LowCardinality(String),
    `Timestamp` DateTime,
    `ServiceName` LowCardinality(String),
    `Duration` UInt64,
    `StatusCode` LowCardinality(String),
    `TraceState` String,
    `DeploymentEnv` LowCardinality(String),
    `CommitSha` LowCardinality(String),
    `SampleRate` Float64 DEFAULT 1,
    `ServiceNamespace` LowCardinality(String),
    INDEX idx_service_namespace ServiceNamespace TYPE set(1000) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, ServiceName, Timestamp)
TTL Timestamp + toIntervalDay(30)
SETTINGS index_granularity = 8192
