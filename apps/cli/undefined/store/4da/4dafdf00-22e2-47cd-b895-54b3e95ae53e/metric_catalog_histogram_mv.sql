ATTACH MATERIALIZED VIEW _ UUID 'eb914759-cde6-4633-ab81-3e885683065a' TO default.metric_catalog
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
    'histogram' AS MetricType,
    ServiceName,
    MetricName,
    anyLast(MetricDescription) AS MetricDescription,
    anyLast(MetricUnit) AS MetricUnit,
    toUInt8(0) AS IsMonotonic,
    count() AS DataPointCount,
    min(toDateTime(TimeUnix)) AS FirstSeen,
    max(toDateTime(TimeUnix)) AS LastSeen
FROM default.metrics_histogram
GROUP BY
    OrgId,
    Hour,
    MetricType,
    ServiceName,
    MetricName
