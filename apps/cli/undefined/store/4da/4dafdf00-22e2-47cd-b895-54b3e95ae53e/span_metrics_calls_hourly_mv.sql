ATTACH MATERIALIZED VIEW _ UUID '609054ee-8e58-4f41-bb1a-b06d6df4b36f' TO default.span_metrics_calls_hourly
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `MetricName` LowCardinality(String),
    `SpanKind` String,
    `AttrFingerprint` UInt64,
    `ResourceFingerprint` UInt64,
    `StartTimeUnix` DateTime64(9),
    `LastValue` AggregateFunction(argMax, Float64, DateTime64(9))
)
AS SELECT
    OrgId,
    toStartOfHour(toDateTime(TimeUnix)) AS Hour,
    ServiceName,
    MetricName,
    Attributes['span.kind'] AS SpanKind,
    cityHash64(mapKeys(Attributes), mapValues(Attributes)) AS AttrFingerprint,
    cityHash64(mapKeys(ResourceAttributes), mapValues(ResourceAttributes)) AS ResourceFingerprint,
    StartTimeUnix,
    argMaxState(Value, TimeUnix) AS LastValue
FROM default.metrics_sum
WHERE (MetricName IN ('span.metrics.calls', 'calls')) AND IsMonotonic
GROUP BY
    OrgId,
    Hour,
    ServiceName,
    MetricName,
    SpanKind,
    AttrFingerprint,
    ResourceFingerprint,
    StartTimeUnix
