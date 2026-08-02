ATTACH TABLE _ UUID '914e1700-bb59-47d5-bb87-d30c16497823'
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
ORDER BY (OrgId, Timestamp, FingerprintHash)
TTL Timestamp + toIntervalDay(90)
SETTINGS index_granularity = 8192
