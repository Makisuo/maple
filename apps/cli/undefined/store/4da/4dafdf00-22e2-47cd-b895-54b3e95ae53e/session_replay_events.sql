ATTACH TABLE _ UUID 'b96fb70d-b686-4401-8ca9-4cb528151b8a'
(
    `OrgId` LowCardinality(String),
    `SessionId` String,
    `ChunkSeq` UInt32,
    `Timestamp` DateTime64(9),
    `DurationMs` UInt32 DEFAULT 0,
    `EventCount` UInt32 DEFAULT 0,
    `ByteSize` UInt32 DEFAULT 0,
    `Events` String,
    `IsCheckpoint` UInt8 DEFAULT 0
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, SessionId, ChunkSeq)
TTL toDate(Timestamp) + toIntervalDay(30)
SETTINGS index_granularity = 8192
