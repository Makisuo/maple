ATTACH MATERIALIZED VIEW _ UUID '5ae8c79b-e6f5-43a8-b8df-5716f50a6dab' TO default.trace_list_mv
(
    `OrgId` LowCardinality(String),
    `TraceId` String,
    `Timestamp` DateTime,
    `ServiceName` LowCardinality(String),
    `SpanName` String,
    `SpanKind` LowCardinality(String),
    `Duration` UInt64,
    `StatusCode` LowCardinality(String),
    `HttpMethod` String,
    `HttpRoute` String,
    `HttpStatusCode` String,
    `DeploymentEnv` String,
    `HasError` UInt8,
    `TraceState` String,
    `ServiceNamespace` String
)
AS SELECT
    OrgId,
    TraceId,
    toDateTime(Timestamp) AS Timestamp,
    ServiceName,
    if(((SpanName LIKE 'http.server %') OR (SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'))) AND (((SpanAttributes['http.route']) != '') OR ((SpanAttributes['url.path']) != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if((SpanAttributes['http.route']) != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS SpanName,
    SpanKind,
    Duration,
    StatusCode,
    if((SpanAttributes['http.method']) != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) AS HttpMethod,
    if((SpanAttributes['http.route']) != '', SpanAttributes['http.route'], if((SpanAttributes['url.path']) != '', SpanAttributes['url.path'], SpanAttributes['http.target'])) AS HttpRoute,
    if((SpanAttributes['http.status_code']) != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) AS HttpStatusCode,
    ResourceAttributes['deployment.environment'] AS DeploymentEnv,
    toUInt8((StatusCode = 'Error') OR (((SpanAttributes['http.status_code']) != '') AND (toUInt16OrZero(SpanAttributes['http.status_code']) >= 500)) OR (((SpanAttributes['http.response.status_code']) != '') AND (toUInt16OrZero(SpanAttributes['http.response.status_code']) >= 500))) AS HasError,
    TraceState,
    ResourceAttributes['service.namespace'] AS ServiceNamespace
FROM default.traces
WHERE ParentSpanId = ''
