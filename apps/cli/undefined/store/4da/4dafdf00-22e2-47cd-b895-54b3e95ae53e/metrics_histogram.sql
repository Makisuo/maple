ATTACH TABLE _ UUID '08bdad1e-5539-491a-8f86-2ef2f2ba6551'
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
    `Count` UInt64,
    `Sum` Float64,
    `BucketCounts` Array(UInt64),
    `ExplicitBounds` Array(Float64),
    `ExemplarsTraceId` Array(String),
    `ExemplarsSpanId` Array(String),
    `ExemplarsTimestamp` Array(DateTime64(9)),
    `ExemplarsValue` Array(Float64),
    `ExemplarsFilteredAttributes` Array(Map(LowCardinality(String), String)),
    `Flags` UInt32,
    `Min` Nullable(Float64),
    `Max` Nullable(Float64),
    `AggregationTemporality` Int32
)
ENGINE = MergeTree
PARTITION BY toDate(TimeUnix)
ORDER BY (OrgId, ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
TTL toDate(TimeUnix) + toIntervalDay(90)
SETTINGS index_granularity = 8192
