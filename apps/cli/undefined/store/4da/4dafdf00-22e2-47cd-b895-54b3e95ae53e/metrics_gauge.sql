ATTACH TABLE _ UUID 'b23c1a75-4689-4996-b227-af94231948ba'
(
    `OrgId` LowCardinality(String),
    `ResourceAttributes` Map(LowCardinality(String), String),
    `ResourceSchemaUrl` String,
    `ScopeName` String,
    `ScopeVersion` String,
    `ScopeAttributes` Map(LowCardinality(String), String),
    `ScopeSchemaUrl` String,
    `ServiceName` LowCardinality(String),
    `MetricName` LowCardinality(String),
    `MetricDescription` LowCardinality(String),
    `MetricUnit` LowCardinality(String),
    `Attributes` Map(LowCardinality(String), String),
    `StartTimeUnix` DateTime64(9),
    `TimeUnix` DateTime64(9),
    `Value` Float64,
    `Flags` UInt32,
    `ExemplarsTraceId` Array(String),
    `ExemplarsSpanId` Array(String),
    `ExemplarsTimestamp` Array(DateTime64(9)),
    `ExemplarsValue` Array(Float64),
    `ExemplarsFilteredAttributes` Array(Map(LowCardinality(String), String))
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (OrgId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
TTL toDate(TimeUnix) + toIntervalDay(90)
SETTINGS index_granularity = 8192
