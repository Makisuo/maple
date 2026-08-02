ATTACH TABLE _ UUID '2327e926-affa-45be-aff3-c7cfbdc26ec5'
(
    `OrgId` LowCardinality(String),
    `Timestamp` DateTime,
    `TraceId` String,
    `SpanId` String,
    `ParentSpanId` String DEFAULT '__unset__',
    `ServiceName` LowCardinality(String),
    `StatusMessage` String,
    `Duration` UInt64,
    `DeploymentEnv` LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, ServiceName, Timestamp)
TTL Timestamp + toIntervalDay(90)
SETTINGS index_granularity = 8192
