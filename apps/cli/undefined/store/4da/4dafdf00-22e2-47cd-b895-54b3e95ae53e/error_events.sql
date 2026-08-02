ATTACH TABLE _ UUID 'ae4f4120-4e3f-4e2f-aad9-3268b3ae1fea'
(
    `OrgId` LowCardinality(String),
    `Timestamp` DateTime,
    `TraceId` String,
    `SpanId` String,
    `ParentSpanId` String DEFAULT '__unset__',
    `ServiceName` LowCardinality(String),
    `DeploymentEnv` LowCardinality(String),
    `ExceptionType` LowCardinality(String),
    `ExceptionMessage` String,
    `ExceptionStacktrace` String,
    `TopFrame` String,
    `FingerprintHash` UInt64,
    `StatusMessage` String,
    `Duration` UInt64,
    `ErrorLabel` String
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, FingerprintHash, Timestamp)
TTL Timestamp + toIntervalDay(90)
SETTINGS index_granularity = 8192
