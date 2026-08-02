ATTACH MATERIALIZED VIEW _ UUID '632eeec8-a2a2-485f-a6c0-faa5f2679fc5' TO default.attribute_values_hourly
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
    toStartOfHour(toDateTime(TimeUnix)) AS Hour,
    AttributeKey,
    AttributeValue,
    'metric' AS AttributeScope,
    count() AS UsageCount
FROM default.metrics_sum
ARRAY JOIN
    mapKeys(Attributes) AS AttributeKey,
    mapValues(Attributes) AS AttributeValue
WHERE AttributeValue != ''
GROUP BY
    OrgId,
    Hour,
    AttributeKey,
    AttributeValue,
    AttributeScope
