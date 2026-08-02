ATTACH MATERIALIZED VIEW _ UUID 'e62e7a38-ab56-4fc5-be3a-6ab9045316cd' TO default.metric_catalog
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
    'exponential_histogram' AS MetricType,
    ServiceName,
    MetricName,
    anyLast(MetricDescription) AS MetricDescription,
    anyLast(MetricUnit) AS MetricUnit,
    toUInt8(0) AS IsMonotonic,
    count() AS DataPointCount,
    min(toDateTime(TimeUnix)) AS FirstSeen,
    max(toDateTime(TimeUnix)) AS LastSeen
FROM default.metrics_exponential_histogram
GROUP BY
    OrgId,
    Hour,
    MetricType,
    ServiceName,
    MetricName
