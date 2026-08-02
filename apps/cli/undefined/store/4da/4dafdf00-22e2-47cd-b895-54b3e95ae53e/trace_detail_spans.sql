ATTACH TABLE _ UUID '86f62ce1-6abb-49b8-bea9-5586ecdb689d'
(
    `OrgId` LowCardinality(String),
    `Timestamp` DateTime64(9),
    `TraceId` String,
    `SpanId` String,
    `ParentSpanId` String,
    `SpanName` LowCardinality(String),
    `SpanKind` LowCardinality(String),
    `ServiceName` LowCardinality(String),
    `Duration` UInt64 DEFAULT 0,
    `StatusCode` LowCardinality(String),
    `StatusMessage` String,
    `SpanAttributes` Map(LowCardinality(String), String),
    `ResourceAttributes` Map(LowCardinality(String), String),
    `EventsTimestamp` Array(DateTime64(9)),
    `EventsName` Array(LowCardinality(String)),
    `EventsAttributes` Array(Map(LowCardinality(String), String))
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, TraceId, SpanId)
TTL toDate(Timestamp) + toIntervalDay(30)
SETTINGS index_granularity = 8192
