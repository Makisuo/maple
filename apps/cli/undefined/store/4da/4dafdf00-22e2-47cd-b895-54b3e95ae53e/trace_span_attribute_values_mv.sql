ATTACH MATERIALIZED VIEW _ UUID '613009e8-daa8-4282-9026-f4f386096890' TO default.attribute_values_hourly
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `AttributeKey` String,
    `AttributeValue` String,
    `AttributeScope` String,
    `UsageCount` UInt64
)
AS SELECT
    OrgId,
    toStartOfHour(toDateTime(Timestamp)) AS Hour,
    AttributeKey,
    AttributeValue,
    'span' AS AttributeScope,
    count() AS UsageCount
FROM default.traces
ARRAY JOIN
    mapKeys(SpanAttributes) AS AttributeKey,
    mapValues(SpanAttributes) AS AttributeValue
WHERE AttributeValue != ''
GROUP BY
    OrgId,
    Hour,
    AttributeKey,
    AttributeValue,
    AttributeScope
