ATTACH MATERIALIZED VIEW _ UUID '2a5b787d-1eae-4578-b699-c0079ad198a1' TO default.attribute_keys_hourly
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
    arrayJoin(mapKeys(ResourceAttributes)) AS AttributeKey,
    'resource' AS AttributeScope,
    count() AS UsageCount
FROM default.traces
WHERE ResourceAttributes != map()
GROUP BY
    OrgId,
    Hour,
    AttributeKey,
    AttributeScope
