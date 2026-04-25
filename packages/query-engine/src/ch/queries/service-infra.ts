// ---------------------------------------------------------------------------
// Service ↔ Infrastructure join
//
// Joins OTel `ServiceName` (on spans) to k8s workload identity
// (`k8s.deployment.name` / `k8s.statefulset.name` / `k8s.daemonset.name` +
// `k8s.namespace.name` + `k8s.cluster.name`, also on spans), then enriches
// with pod count and CPU/memory limit utilization aggregated from the
// matching k8s.pod.* gauges in metrics_gauge.
//
// Spans only carry the workload identity when the agent's `k8sattributes`
// processor has tagged them — see deploy/k8s-infra/values.yaml. Services
// with no k8s context simply produce no rows here, which the UI renders as
// an empty Infrastructure tab.
// ---------------------------------------------------------------------------

import { escapeClickHouseString } from "../../sql/sql-fragment"
import type { CompiledQuery } from "../compile"

export interface ServiceWorkloadsOpts {
  services: ReadonlyArray<string>
}

export interface ServiceWorkloadsOutput {
  readonly serviceName: string
  readonly workloadKind: "deployment" | "statefulset" | "daemonset" | "unknown"
  readonly workloadName: string
  readonly namespace: string
  readonly clusterName: string
  readonly podCount: number
  readonly avgCpuLimitUtilization: number | null
  readonly avgMemoryLimitUtilization: number | null
}

export function serviceWorkloadsSQL(
  opts: ServiceWorkloadsOpts,
  params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<ServiceWorkloadsOutput> {
  const esc = escapeClickHouseString
  const orgId = esc(params.orgId)
  const startTime = esc(params.startTime)
  const endTime = esc(params.endTime)
  const serviceList = opts.services
    .map((s) => `'${esc(s)}'`)
    .join(", ")

  // Bail early if no services were passed — return an empty result via a
  // trivial SELECT that produces zero rows.
  if (opts.services.length === 0) {
    return {
      sql: `SELECT '' AS serviceName, '' AS workloadKind, '' AS workloadName,
       '' AS namespace, '' AS clusterName,
       toUInt64(0) AS podCount,
       toNullable(toFloat64(0)) AS avgCpuLimitUtilization,
       toNullable(toFloat64(0)) AS avgMemoryLimitUtilization
WHERE 0
FORMAT JSON`,
      castRows: (rows) => rows as unknown as ReadonlyArray<ServiceWorkloadsOutput>,
    }
  }

  const sql = `WITH
  service_workload_map AS (
    SELECT DISTINCT
      ServiceName AS serviceName,
      multiIf(
        ResourceAttributes['k8s.deployment.name']  != '', 'deployment',
        ResourceAttributes['k8s.statefulset.name'] != '', 'statefulset',
        ResourceAttributes['k8s.daemonset.name']   != '', 'daemonset',
        'unknown'
      ) AS workloadKind,
      multiIf(
        ResourceAttributes['k8s.deployment.name']  != '', ResourceAttributes['k8s.deployment.name'],
        ResourceAttributes['k8s.statefulset.name'] != '', ResourceAttributes['k8s.statefulset.name'],
        ResourceAttributes['k8s.daemonset.name']   != '', ResourceAttributes['k8s.daemonset.name'],
        ''
      ) AS workloadName,
      ResourceAttributes['k8s.namespace.name'] AS namespace,
      ResourceAttributes['k8s.cluster.name']   AS clusterName
    FROM traces
    WHERE OrgId = '${orgId}'
      AND Timestamp >= toDateTime('${startTime}')
      AND Timestamp <= toDateTime('${endTime}')
      AND ServiceName IN (${serviceList})
      AND (
        ResourceAttributes['k8s.deployment.name']  != ''
        OR ResourceAttributes['k8s.statefulset.name'] != ''
        OR ResourceAttributes['k8s.daemonset.name']   != ''
      )
  ),
  workload_metrics AS (
    SELECT
      multiIf(
        ResourceAttributes['k8s.deployment.name']  != '', 'deployment',
        ResourceAttributes['k8s.statefulset.name'] != '', 'statefulset',
        ResourceAttributes['k8s.daemonset.name']   != '', 'daemonset',
        'unknown'
      ) AS workloadKind,
      multiIf(
        ResourceAttributes['k8s.deployment.name']  != '', ResourceAttributes['k8s.deployment.name'],
        ResourceAttributes['k8s.statefulset.name'] != '', ResourceAttributes['k8s.statefulset.name'],
        ResourceAttributes['k8s.daemonset.name']   != '', ResourceAttributes['k8s.daemonset.name'],
        ''
      ) AS workloadName,
      ResourceAttributes['k8s.namespace.name'] AS namespace,
      ResourceAttributes['k8s.cluster.name']   AS clusterName,
      uniq(ResourceAttributes['k8s.pod.uid']) AS podCount,
      avgIf(Value, MetricName = 'k8s.pod.cpu_limit_utilization') AS avgCpuLimitPct,
      avgIf(Value, MetricName = 'k8s.pod.memory_limit_utilization') AS avgMemoryLimitPct
    FROM metrics_gauge
    WHERE OrgId = '${orgId}'
      AND TimeUnix >= toDateTime('${startTime}')
      AND TimeUnix <= toDateTime('${endTime}')
      AND MetricName IN (
        'k8s.pod.cpu_limit_utilization',
        'k8s.pod.memory_limit_utilization'
      )
      AND ResourceAttributes['k8s.pod.uid'] != ''
    GROUP BY workloadKind, workloadName, namespace, clusterName
  )
SELECT
  swm.serviceName AS serviceName,
  swm.workloadKind AS workloadKind,
  swm.workloadName AS workloadName,
  swm.namespace AS namespace,
  swm.clusterName AS clusterName,
  toUInt64(coalesce(wm.podCount, 0)) AS podCount,
  wm.avgCpuLimitPct AS avgCpuLimitUtilization,
  wm.avgMemoryLimitPct AS avgMemoryLimitUtilization
FROM service_workload_map AS swm
LEFT JOIN workload_metrics AS wm
  ON swm.workloadKind = wm.workloadKind
  AND swm.workloadName = wm.workloadName
  AND swm.namespace    = wm.namespace
  AND swm.clusterName  = wm.clusterName
WHERE swm.workloadName != ''
ORDER BY swm.serviceName ASC, swm.workloadName ASC
LIMIT 500
FORMAT JSON`

  return {
    sql,
    castRows: (rows) => rows as unknown as ReadonlyArray<ServiceWorkloadsOutput>,
  }
}
