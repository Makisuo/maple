ATTACH MATERIALIZED VIEW _ UUID '13bdbc2b-6fa0-4bae-b485-c74203ef3582' TO default.attribute_values_hourly
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
    'resource' AS AttributeScope,
    count() AS UsageCount
FROM default.traces
ARRAY JOIN
    mapKeys(ResourceAttributes) AS AttributeKey,
    mapValues(ResourceAttributes) AS AttributeValue
WHERE AttributeValue != ''
GROUP BY
    OrgId,
    Hour,
    AttributeKey,
    AttributeValue,
    AttributeScope
