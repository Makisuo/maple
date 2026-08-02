ATTACH MATERIALIZED VIEW _ UUID 'a5e0cac5-bcc8-410c-b025-39d784ad68b2' TO default.attribute_keys_hourly
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `AttributeKey` String,
    `AttributeScope` String,
    `UsageCount` UInt64
)
AS SELECT
    OrgId,
    toStartOfHour(toDateTime(TimeUnix)) AS Hour,
    arrayJoin(mapKeys(Attributes)) AS AttributeKey,
    'metric' AS AttributeScope,
    count() AS UsageCount
FROM default.metrics_sum
WHERE Attributes != map()
GROUP BY
    OrgId,
    Hour,
    AttributeKey,
    AttributeScope
