ATTACH MATERIALIZED VIEW _ UUID 'b9d02e06-789c-45db-a63a-a73a55e372bf' TO default.service_map_db_edges_hourly
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `DbSystem` String,
    `DbNamespace` String,
    `DeploymentEnv` String,
    `CallCount` UInt64,
    `ErrorCount` UInt64,
    `DurationSumMs` Float64,
    `MaxDurationMs` Float64,
    `SampledSpanCount` UInt64,
    `UnsampledSpanCount` UInt64,
    `SampleRateSum` Float64
)
AS SELECT
    OrgId,
    toStartOfHour(toDateTime(Timestamp)) AS Hour,
    ServiceName,
    coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) AS DbSystem,
    if(match(coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name']), '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name'])) AS DbNamespace,
    ResourceAttributes['deployment.environment'] AS DeploymentEnv,
    count() AS CallCount,
    countIf(StatusCode = 'Error') AS ErrorCount,
    sum(Duration / 1000000) AS DurationSumMs,
    max(Duration / 1000000) AS MaxDurationMs,
    countIf(TraceState LIKE '%th:%') AS SampledSpanCount,
    countIf((TraceState = '') OR (TraceState NOT LIKE '%th:%')) AS UnsampledSpanCount,
    sum(SampleRate) AS SampleRateSum
FROM default.traces
WHERE (SpanKind IN ('Client', 'Producer')) AND (coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) != '') AND (ServiceName != '')
GROUP BY
    OrgId,
    Hour,
    ServiceName,
    DbSystem,
    DbNamespace,
    DeploymentEnv
