ATTACH TABLE _ UUID 'd202dfdc-d9b4-44c2-9f65-757d9f4e6ae3'
(
    `OrgId` LowCardinality(String),
    `Timestamp` DateTime64(9),
    `TraceId` String,
    `SpanId` String,
    `ParentSpanId` String,
    `TraceState` String,
    `SpanName` LowCardinality(String),
    `SpanKind` LowCardinality(String),
    `ServiceName` LowCardinality(String),
    `ResourceSchemaUrl` String,
    `ResourceAttributes` Map(LowCardinality(String), String),
    `ScopeSchemaUrl` String,
    `ScopeName` String,
    `ScopeVersion` String,
    `ScopeAttributes` Map(LowCardinality(String), String),
    `Duration` UInt64 DEFAULT 0,
    `StatusCode` LowCardinality(String),
    `StatusMessage` String,
    `SpanAttributes` Map(LowCardinality(String), String),
    `EventsTimestamp` Array(DateTime64(9)),
    `EventsName` Array(LowCardinality(String)),
    `EventsAttributes` Array(Map(LowCardinality(String), String)),
    `LinksTraceId` Array(String),
    `LinksSpanId` Array(String),
    `LinksTraceState` Array(String),
    `LinksAttributes` Array(Map(LowCardinality(String), String)),
    `SampleRate` Float64 DEFAULT multiIf(((SpanAttributes['SampleRate']) != '') AND (toFloat64OrZero(SpanAttributes['SampleRate']) >= 1.), toFloat64OrZero(SpanAttributes['SampleRate']), match(TraceState, 'th:[0-9a-f]+'), 1. / greatest(1. - (reinterpretAsUInt64(reverse(unhex(rightPad(extract(TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2., 64)), 0.0001), 1.),
    `IsEntryPoint` UInt8 DEFAULT if((SpanKind IN ('Server', 'Consumer')) OR (ParentSpanId = ''), 1, 0),
    `ResourceAttributeItems` Array(String) DEFAULT arrayMap((k, v) -> concat(k, char(31), v), mapKeys(ResourceAttributes), mapValues(ResourceAttributes)),
    `ScopeAttributeItems` Array(String) DEFAULT arrayMap((k, v) -> concat(k, char(31), v), mapKeys(ScopeAttributes), mapValues(ScopeAttributes)),
    `SpanAttributeItems` Array(String) DEFAULT arrayMap((k, v) -> concat(k, char(31), v), mapKeys(SpanAttributes), mapValues(SpanAttributes)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_keys mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_vals mapValues(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_resource_attr_keys mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_resource_attr_vals mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_keys mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_vals mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (OrgId, ServiceName, SpanName, toDateTime(Timestamp))
TTL toDate(Timestamp) + toIntervalDay(30)
SETTINGS index_granularity = 8192
