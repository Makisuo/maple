ATTACH MATERIALIZED VIEW _ UUID '8208fc48-eda4-4ae3-98b0-bee3ab605b92' TO default.metric_catalog
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
    'sum' AS MetricType,
    ServiceName,
    MetricName,
    anyLast(MetricDescription) AS MetricDescription,
    anyLast(MetricUnit) AS MetricUnit,
    anyLast(toUInt8(IsMonotonic)) AS IsMonotonic,
    count() AS DataPointCount,
    min(toDateTime(TimeUnix)) AS FirstSeen,
    max(toDateTime(TimeUnix)) AS LastSeen
FROM default.metrics_sum
GROUP BY
    OrgId,
    Hour,
    MetricType,
    ServiceName,
    MetricName
