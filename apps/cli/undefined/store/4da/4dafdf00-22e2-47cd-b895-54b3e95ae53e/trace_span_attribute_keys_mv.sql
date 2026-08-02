ATTACH MATERIALIZED VIEW _ UUID '17318bf4-44bf-4ceb-a003-584c2f7cc208' TO default.attribute_keys_hourly
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `AttributeKey` String,
    `AttributeScope` String,
    `UsageCount` UInt64
)
AS SELECT
    OrgId,
    toStartOfHour(toDateTime(Timestamp)) AS Hour,
    arrayJoin(mapKeys(SpanAttributes)) AS AttributeKey,
    'span' AS AttributeScope,
    count() AS UsageCount
FROM default.traces
WHERE SpanAttributes != map()
GROUP BY
    OrgId,
    Hour,
    AttributeKey,
    AttributeScope
