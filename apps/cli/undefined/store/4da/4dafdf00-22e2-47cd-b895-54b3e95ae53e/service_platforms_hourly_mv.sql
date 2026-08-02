ATTACH MATERIALIZED VIEW _ UUID 'dec3b657-d96e-43e3-bbf9-c7b15748bdc1' TO default.service_platforms_hourly
(
    `OrgId` LowCardinality(String),
    `Hour` DateTime,
    `ServiceName` LowCardinality(String),
    `DeploymentEnv` String,
    `K8sCluster` String,
    `K8sPodName` String,
    `K8sDeploymentName` String,
    `K8sStatefulSetName` String,
    `K8sDaemonSetName` String,
    `K8sNamespaceName` String,
    `CloudPlatform` String,
    `CloudProvider` String,
    `FaasName` String,
    `MapleSdkType` String,
    `ProcessRuntimeName` String,
    `SpanCount` UInt64
)
AS SELECT
    OrgId,
    toStartOfHour(toDateTime(Timestamp)) AS Hour,
    ServiceName,
    ResourceAttributes['deployment.environment'] AS DeploymentEnv,
    max(ResourceAttributes['k8s.cluster.name']) AS K8sCluster,
    max(ResourceAttributes['k8s.pod.name']) AS K8sPodName,
    max(ResourceAttributes['k8s.deployment.name']) AS K8sDeploymentName,
    max(ResourceAttributes['k8s.statefulset.name']) AS K8sStatefulSetName,
    max(ResourceAttributes['k8s.daemonset.name']) AS K8sDaemonSetName,
    max(ResourceAttributes['k8s.namespace.name']) AS K8sNamespaceName,
    max(ResourceAttributes['cloud.platform']) AS CloudPlatform,
    max(ResourceAttributes['cloud.provider']) AS CloudProvider,
    max(ResourceAttributes['faas.name']) AS FaasName,
    max(ResourceAttributes['maple.sdk.type']) AS MapleSdkType,
    max(ResourceAttributes['process.runtime.name']) AS ProcessRuntimeName,
    count() AS SpanCount
FROM default.traces
WHERE ServiceName != ''
GROUP BY
    OrgId,
    Hour,
    ServiceName,
    DeploymentEnv
