ATTACH MATERIALIZED VIEW _ UUID '29803b9d-325c-4fbf-b288-3bd9fcf72232' TO default.trace_detail_spans
(
    `OrgId` LowCardinality(String),
    `Timestamp` DateTime64(9),
    `TraceId` String,
    `SpanId` String,
    `ParentSpanId` String,
    `SpanName` LowCardinality(String),
    `SpanKind` LowCardinality(String),
    `ServiceName` LowCardinality(String),
    `Duration` UInt64,
    `StatusCode` LowCardinality(String),
    `StatusMessage` String,
    `SpanAttributes` Map(LowCardinality(String), String),
    `ResourceAttributes` Map(LowCardinality(String), String),
    `EventsTimestamp` Array(DateTime64(9)),
    `EventsName` Array(LowCardinality(String)),
    `EventsAttributes` Array(Map(LowCardinality(String), String))
)
AS SELECT
    OrgId,
    Timestamp,
    TraceId,
    SpanId,
    ParentSpanId,
    SpanName,
    SpanKind,
    ServiceName,
    Duration,
    StatusCode,
    StatusMessage,
    SpanAttributes,
    ResourceAttributes,
    EventsTimestamp,
    EventsName,
    EventsAttributes
FROM default.traces
