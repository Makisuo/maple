ATTACH MATERIALIZED VIEW _ UUID '22d6ba57-0b13-4ff1-ab12-4bb3118861e9' TO default.attribute_keys_hourly
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
    arrayJoin(mapKeys(LogAttributes)) AS AttributeKey,
    'log' AS AttributeScope,
    count() AS UsageCount
FROM default.logs
WHERE LogAttributes != map()
GROUP BY
    OrgId,
    Hour,
    AttributeKey,
    AttributeScope
