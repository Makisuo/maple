ATTACH TABLE _ UUID '713877bc-60db-429f-8e3c-435b114f2f4c'
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
    `DeploymentEnv` LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, TraceId, SpanId, Timestamp)
TTL Timestamp + toIntervalDay(30)
SETTINGS index_granularity = 8192
