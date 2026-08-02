ATTACH TABLE _ UUID '73dba5af-e282-4bbd-a501-fcc5f56f2fe6'
(
    `OrgId` LowCardinality(String),
    `Timestamp` DateTime64(9),
    `TimestampTime` DateTime,
    `TraceId` String,
    `SpanId` String,
    `TraceFlags` UInt8,
    `SeverityText` LowCardinality(String),
    `SeverityNumber` UInt8,
    `ServiceName` LowCardinality(String),
    `Body` String,
    `ResourceSchemaUrl` String,
    `ResourceAttributes` Map(LowCardinality(String), String),
    `ScopeSchemaUrl` String,
    `ScopeName` String,
    `ScopeVersion` String,
    `ScopeAttributes` Map(LowCardinality(String), String),
    `LogAttributes` Map(LowCardinality(String), String),
    `ResourceAttributeItems` Array(String) DEFAULT arrayMap((k, v) -> concat(k, char(31), v), mapKeys(ResourceAttributes), mapValues(ResourceAttributes)),
    `ScopeAttributeItems` Array(String) DEFAULT arrayMap((k, v) -> concat(k, char(31), v), mapKeys(ScopeAttributes), mapValues(ScopeAttributes)),
    `LogAttributeItems` Array(String) DEFAULT arrayMap((k, v) -> concat(k, char(31), v), mapKeys(LogAttributes), mapValues(LogAttributes)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_resource_attr_keys mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_resource_attr_vals mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_keys mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_vals mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_log_attr_keys mapKeys(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_log_attr_vals mapValues(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_lower_body lower(Body) TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8
)
ENGINE = MergeTree
PARTITION BY toDate(TimestampTime)
ORDER BY (OrgId, toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp)
TTL toDate(TimestampTime) + toIntervalDay(30)
SETTINGS index_granularity = 8192
