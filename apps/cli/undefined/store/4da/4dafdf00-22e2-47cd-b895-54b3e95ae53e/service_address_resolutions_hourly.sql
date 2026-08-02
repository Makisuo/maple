ATTACH TABLE _ UUID '90e72481-c657-4456-9a62-6d94d64f2810'
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `SourceService` LowCardinality(String),
    `ParentServerAddress` String,
    `ResolvedTargetService` LowCardinality(String),
    `DeploymentEnv` LowCardinality(String)
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, Hour, DeploymentEnv, SourceService, ParentServerAddress, ResolvedTargetService)
TTL toDate(Hour) + toIntervalDay(365)
SETTINGS index_granularity = 8192
