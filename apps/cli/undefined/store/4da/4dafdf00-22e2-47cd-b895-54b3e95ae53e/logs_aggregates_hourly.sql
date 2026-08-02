ATTACH TABLE _ UUID '2d419b29-5f6b-48bf-b3e4-feafbf7e7788'
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `SeverityText` LowCardinality(String),
    `DeploymentEnv` LowCardinality(String),
    `Count` SimpleAggregateFunction(sum, UInt64),
    `SizeBytes` SimpleAggregateFunction(sum, UInt64),
    `ServiceNamespace` LowCardinality(String),
    INDEX idx_service_namespace ServiceNamespace TYPE set(1000) GRANULARITY 4
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, Hour, ServiceName, SeverityText, DeploymentEnv, ServiceNamespace)
TTL toDate(Hour) + toIntervalDay(365)
SETTINGS index_granularity = 8192
