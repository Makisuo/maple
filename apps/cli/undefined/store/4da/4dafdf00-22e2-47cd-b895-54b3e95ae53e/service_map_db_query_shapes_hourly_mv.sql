ATTACH MATERIALIZED VIEW _ UUID '4ac57bb1-7d07-4ba7-a9cd-2b895cb65052' TO default.service_map_db_query_shapes_hourly
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `DbSystem` String,
    `DbNamespace` String,
    `DeploymentEnv` String,
    `QueryKey` String,
    `QueryLabel` String,
    `SampleStatement` String,
    `CallCount` UInt64,
    `ErrorCount` UInt64,
    `EstimatedCount` Float64,
    `EstimatedErrorCount` Float64,
    `WeightedDurationSumMs` Float64,
    `DurationQuantiles` AggregateFunction(quantilesTDigestWeighted(0.5, 0.95), UInt64, UInt32)
)
AS SELECT
    OrgId,
    toStartOfHour(toDateTime(Timestamp)) AS Hour,
    ServiceName,
    coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) AS DbSystem,
    if(match(coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name']), '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name'])) AS DbNamespace,
    ResourceAttributes['deployment.environment'] AS DeploymentEnv,
    coalesce(nullIf(SpanAttributes['db.query.fingerprint'], ''), nullIf(SpanAttributes['db.statement.fingerprint'], ''), nullIf(if(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']) != '', toString(cityHash64(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(lower(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement'])), '\'[^\']*\'', '?'), '\\bin\\s*\\([^)]*\\)', 'in (?)'), '[0-9]+(\\.[0-9]+)?', '?'), '\\s+', ' '), '^\\s+|\\s+$', ''))), ''), ''), toString(cityHash64(coalesce(nullIf(SpanAttributes['db.query.summary'], ''), nullIf(if((SpanAttributes['db.operation.name']) != '', trimBoth(concat(SpanAttributes['db.operation.name'], if(coalesce(nullIf(SpanAttributes['db.collection.name'], ''), SpanAttributes['db.namespace']) != '', concat(' ', coalesce(nullIf(SpanAttributes['db.collection.name'], ''), SpanAttributes['db.namespace'])), ''))), ''), ''), nullIf(if(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']) != '', trimBoth(concat(upper(extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '^\\s*(\\w+)')), if(extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '(?i)(?:from|into|update|join|table)\\s+\\W?([\\w.]+)') != '', concat(' ', extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '(?i)(?:from|into|update|join|table)\\s+\\W?([\\w.]+)')), ''))), ''), ''), nullIf(SpanAttributes['query.context'], ''), nullIf(SpanAttributes['db.operation.name'], ''), nullIf(SpanAttributes['db.operation'], ''), SpanName)))) AS QueryKey,
    any(substring(coalesce(nullIf(SpanAttributes['db.query.summary'], ''), nullIf(if((SpanAttributes['db.operation.name']) != '', trimBoth(concat(SpanAttributes['db.operation.name'], if(coalesce(nullIf(SpanAttributes['db.collection.name'], ''), SpanAttributes['db.namespace']) != '', concat(' ', coalesce(nullIf(SpanAttributes['db.collection.name'], ''), SpanAttributes['db.namespace'])), ''))), ''), ''), nullIf(if(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']) != '', trimBoth(concat(upper(extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '^\\s*(\\w+)')), if(extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '(?i)(?:from|into|update|join|table)\\s+\\W?([\\w.]+)') != '', concat(' ', extract(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), '(?i)(?:from|into|update|join|table)\\s+\\W?([\\w.]+)')), ''))), ''), ''), nullIf(SpanAttributes['query.context'], ''), nullIf(SpanAttributes['db.operation.name'], ''), nullIf(SpanAttributes['db.operation'], ''), SpanName), 1, 220)) AS QueryLabel,
    any(substring(coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']), 1, 1000)) AS SampleStatement,
    count() AS CallCount,
    countIf(StatusCode = 'Error') AS ErrorCount,
    sum(SampleRate) AS EstimatedCount,
    sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
    sum((toFloat64(Duration) * SampleRate) / 1000000) AS WeightedDurationSumMs,
    quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.))) AS DurationQuantiles
FROM default.traces
WHERE (SpanKind IN ('Client', 'Producer')) AND (coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) != '') AND (ServiceName != '')
GROUP BY
    OrgId,
    Hour,
    ServiceName,
    DbSystem,
    DbNamespace,
    DeploymentEnv,
    QueryKey
