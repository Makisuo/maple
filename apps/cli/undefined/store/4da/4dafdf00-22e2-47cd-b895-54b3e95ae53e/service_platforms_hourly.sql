ATTACH TABLE _ UUID 'fb105b21-26be-46de-975c-dbb91d655d18'
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `DeploymentEnv` LowCardinality(String),
    `K8sCluster` SimpleAggregateFunction(max, String),
    `K8sPodName` SimpleAggregateFunction(max, String),
    `K8sDeploymentName` SimpleAggregateFunction(max, String),
    `K8sStatefulSetName` SimpleAggregateFunction(max, String),
    `K8sDaemonSetName` SimpleAggregateFunction(max, String),
    `K8sNamespaceName` SimpleAggregateFunction(max, String),
    `CloudPlatform` SimpleAggregateFunction(max, String),
    `CloudProvider` SimpleAggregateFunction(max, String),
    `FaasName` SimpleAggregateFunction(max, String),
    `MapleSdkType` SimpleAggregateFunction(max, String),
    `ProcessRuntimeName` SimpleAggregateFunction(max, String),
    `SpanCount` SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(Hour)
ORDER BY (OrgId, Hour, ServiceName, DeploymentEnv)
TTL toDate(Hour) + toIntervalDay(365)
SETTINGS index_granularity = 8192
