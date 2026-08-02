ATTACH MATERIALIZED VIEW _ UUID '13ac806e-6aff-4381-975e-1b1faa07a075' TO default.service_external_edges_hourly
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `TargetType` String,
    `TargetSystem` String,
    `TargetName` String,
    `DeploymentEnv` String,
    `CallCount` UInt64,
    `ErrorCount` UInt64,
    `DurationSumMs` Float64,
    `MaxDurationMs` Float64,
    `SampleRateSum` Float64
)
AS SELECT
    OrgId,
    toStartOfHour(toDateTime(Timestamp)) AS Hour,
    ServiceName,
    multiIf(((SpanAttributes['messaging.destination']) != '') OR ((SpanAttributes['messaging.system']) != ''), 'messaging', ((SpanAttributes['rpc.service']) != '') OR ((SpanAttributes['rpc.system']) != ''), 'rpc', 'http') AS TargetType,
    multiIf(((SpanAttributes['messaging.destination']) != '') OR ((SpanAttributes['messaging.system']) != ''), SpanAttributes['messaging.system'], ((SpanAttributes['rpc.service']) != '') OR ((SpanAttributes['rpc.system']) != ''), SpanAttributes['rpc.system'], '') AS TargetSystem,
    multiIf(((SpanAttributes['messaging.destination']) != '') OR ((SpanAttributes['messaging.system']) != ''), if((SpanAttributes['messaging.destination']) != '', SpanAttributes['messaging.destination'], SpanAttributes['messaging.system']), ((SpanAttributes['rpc.service']) != '') OR ((SpanAttributes['rpc.system']) != ''), if((SpanAttributes['rpc.service']) != '', SpanAttributes['rpc.service'], SpanAttributes['rpc.system']), if((SpanAttributes['server.address']) != '', SpanAttributes['server.address'], if((SpanAttributes['http.host']) != '', SpanAttributes['http.host'], SpanAttributes['url.authority']))) AS TargetName,
    ResourceAttributes['deployment.environment'] AS DeploymentEnv,
    count() AS CallCount,
    countIf(StatusCode = 'Error') AS ErrorCount,
    sum(Duration / 1000000) AS DurationSumMs,
    max(Duration / 1000000) AS MaxDurationMs,
    sum(SampleRate) AS SampleRateSum
FROM default.traces
WHERE (SpanKind IN ('Client', 'Producer')) AND ((SpanAttributes['db.system.name']) = '') AND (ServiceName != '') AND (((SpanAttributes['server.address']) != '') OR ((SpanAttributes['http.host']) != '') OR ((SpanAttributes['url.authority']) != '') OR ((SpanAttributes['messaging.destination']) != '') OR ((SpanAttributes['messaging.system']) != '') OR ((SpanAttributes['rpc.service']) != '') OR ((SpanAttributes['rpc.system']) != ''))
GROUP BY
    OrgId,
    Hour,
    ServiceName,
    TargetType,
    TargetSystem,
    TargetName,
    DeploymentEnv
HAVING TargetName != ''
