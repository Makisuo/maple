ATTACH MATERIALIZED VIEW _ UUID '87e049a3-6957-4389-8340-8a14a16392ed' TO default.logs_aggregates_hourly
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `SeverityText` LowCardinality(String),
    `DeploymentEnv` String,
    `Count` UInt64,
    `SizeBytes` UInt64,
    `ServiceNamespace` String
)
AS SELECT
    OrgId,
    toStartOfHour(TimestampTime) AS Hour,
    ServiceName,
    SeverityText,
    ResourceAttributes['deployment.environment'] AS DeploymentEnv,
    count() AS Count,
    sum(length(Body) + 200) AS SizeBytes,
    ResourceAttributes['service.namespace'] AS ServiceNamespace
FROM default.logs
GROUP BY
    OrgId,
    Hour,
    ServiceName,
    SeverityText,
    DeploymentEnv,
    ServiceNamespace
