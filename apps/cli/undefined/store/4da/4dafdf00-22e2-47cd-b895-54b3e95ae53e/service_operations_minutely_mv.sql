ATTACH MATERIALIZED VIEW _ UUID 'af5aedeb-18d0-4b64-bfde-3f7ec3519910' TO default.service_operations_minutely
(
    `OrgId` LowCardinality(String),
    `Minute` DateTime,
    `ServiceName` LowCardinality(String),
    `DeploymentEnv` String,
    `SpanName` String,
    `SpanCount` UInt64,
    `EstimatedSpanCount` Float64,
    `ErrorCount` UInt64,
    `EstimatedErrorCount` Float64,
    `DurationSum` Float64,
    `DurationQuantiles` AggregateFunction(quantilesTDigest(0.5, 0.95), UInt64)
)
AS SELECT
    OrgId,
    toStartOfMinute(toDateTime(Timestamp)) AS Minute,
    ServiceName,
    ResourceAttributes['deployment.environment'] AS DeploymentEnv,
    if(((SpanName LIKE 'http.server %') OR (SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'))) AND (((SpanAttributes['http.route']) != '') OR ((SpanAttributes['url.path']) != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if((SpanAttributes['http.route']) != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS SpanName,
    count() AS SpanCount,
    sum(SampleRate) AS EstimatedSpanCount,
    countIf(StatusCode = 'Error') AS ErrorCount,
    sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
    sum(toFloat64(Duration)) AS DurationSum,
    quantilesTDigestState(0.5, 0.95)(Duration) AS DurationQuantiles
FROM default.traces
GROUP BY
    OrgId,
    Minute,
    ServiceName,
    DeploymentEnv,
    SpanName
