ATTACH TABLE _ UUID 'd716c3f9-0eb3-4dc3-91c4-78ed58cf02c1'
(
    `OrgId` LowCardinality(String),
    `SessionId` String,
    `Timestamp` DateTime64(9),
    `Seq` UInt32 DEFAULT 0,
    `Type` LowCardinality(String),
    `Url` String DEFAULT '',
    `TraceId` String DEFAULT '',
    `Level` LowCardinality(String) DEFAULT '',
    `Message` String DEFAULT '',
    `TargetSelector` String DEFAULT '',
    `TargetText` String DEFAULT '',
    `NetMethod` LowCardinality(String) DEFAULT '',
    `NetUrl` String DEFAULT '',
    `NetStatus` UInt16 DEFAULT 0,
    `NetDurationMs` UInt32 DEFAULT 0,
    `ErrorStack` String DEFAULT '',
    `Attributes` Map(String, String),
    INDEX idx_type Type TYPE set(16) GRANULARITY 4
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, SessionId, Timestamp, Seq)
TTL toDate(Timestamp) + toIntervalDay(30)
SETTINGS index_granularity = 8192
