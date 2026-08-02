ATTACH MATERIALIZED VIEW _ UUID '4abba424-b616-4e24-b0a8-71b194239835' TO default.attribute_values_hourly
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
    'log' AS AttributeScope,
    count() AS UsageCount
FROM default.logs
ARRAY JOIN
    mapKeys(LogAttributes) AS AttributeKey,
    mapValues(LogAttributes) AS AttributeValue
WHERE AttributeValue != ''
GROUP BY
    OrgId,
    Hour,
    AttributeKey,
    AttributeValue,
    AttributeScope
