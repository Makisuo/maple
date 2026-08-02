ATTACH MATERIALIZED VIEW _ UUID '7a8525a6-d5d2-4a3c-abcc-14bbb212c379' TO default.metric_catalog
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `MetricType` String,
    `ServiceName` LowCardinality(String),
    `MetricName` LowCardinality(String),
    `MetricDescription` String,
    `MetricUnit` String,
    `IsMonotonic` UInt8,
    `DataPointCount` UInt64,
    `FirstSeen` DateTime,
    `LastSeen` DateTime
)
AS SELECT
    OrgId,
    toStartOfHour(toDateTime(TimeUnix)) AS Hour,
    'gauge' AS MetricType,
    ServiceName,
    MetricName,
    anyLast(MetricDescription) AS MetricDescription,
    anyLast(MetricUnit) AS MetricUnit,
    toUInt8(0) AS IsMonotonic,
    count() AS DataPointCount,
    min(toDateTime(TimeUnix)) AS FirstSeen,
    max(toDateTime(TimeUnix)) AS LastSeen
FROM default.metrics_gauge
GROUP BY
    OrgId,
    Hour,
    MetricType,
    ServiceName,
    MetricName
