// ---------------------------------------------------------------------------
// Service ↔ Infrastructure join
//
// Joins OTel `ServiceName` to k8s workload identity (`k8s.deployment.name` /
// `k8s.statefulset.name` / `k8s.daemonset.name` + `k8s.namespace.name`), then
// enriches with pod count and CPU/memory limit utilization aggregated from the
// matching k8s.pod.* gauges in metrics_gauge.
//
// Workload identity is read from the pre-aggregated `service_platforms_hourly`
// MV (one row per service/env/hour) rather than scanning raw `traces` — the MV
// uses `max()` per attribute, so it yields the dominant workload per service.
// A service genuinely spread across multiple deployments shows its dominant
// one. Services with no k8s context produce no rows, which the UI renders as
// an empty Infrastructure tab.
//
// The JOIN keys on kind/name/namespace only. `k8s.cluster.name` is deliberately
// NOT a key: it's tagged on the kubeletstats pod gauges but never on spans (the
// `k8sattributes` processor doesn't set it), so joining on it dropped every row
// and pod counts always read 0. Cluster is sourced from the metrics side for
// display only.
//
// The span-side k8s attributes are only present when the agent's `k8sattributes`
// processor has tagged the spans — see deploy/k8s-infra/values.yaml.
//
// Built with the ClickHouse query-builder DSL (a `fromQuery(...).leftJoinQuery`
// over two grouped subqueries), then compiled to SQL — no hand-written SQL.
// ---------------------------------------------------------------------------

import { Schema } from "effect"
import {
	compileCH,
	unsafeCompiledQuery,
	type CompiledQuery,
	type CompiledQueryRowSchema,
} from "@maple-dev/clickhouse-builder"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from, fromQuery } from "@maple-dev/clickhouse-builder"
import { MetricsGauge, ServicePlatformsHourly } from "../tables"
import { CHNumber } from "../schema"


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

const ServiceWorkloadsOutputSchema: CompiledQueryRowSchema<ServiceWorkloadsOutput> = Schema.Struct({
	serviceName: Schema.String,
	workloadKind: Schema.Literals(["deployment", "statefulset", "daemonset", "unknown"]),
	workloadName: Schema.String,
	namespace: Schema.String,
	clusterName: Schema.String,
	podCount: CHNumber,
	avgCpuLimitUtilization: Schema.NullOr(CHNumber),
	avgMemoryLimitUtilization: Schema.NullOr(CHNumber),
})

// `IN ()` is invalid SQL, so an empty service list short-circuits to a
// zero-row result with the right column shape.
const EMPTY_WORKLOADS_SQL = `SELECT '' AS serviceName, '' AS workloadKind, '' AS workloadName,
       '' AS namespace, '' AS clusterName,
       toUInt64(0) AS podCount,
       toNullable(toFloat64(0)) AS avgCpuLimitUtilization,
       toNullable(toFloat64(0)) AS avgMemoryLimitUtilization
WHERE 0
FORMAT JSON`

export function serviceWorkloadsSQL(
	opts: ServiceWorkloadsOpts,
	params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<ServiceWorkloadsOutput> {
	if (opts.services.length === 0) {
		// Reads no table at all (`WHERE 0`), so it cannot cross tenants; it stands
		// in for a scoped call whose service list was empty.
		return unsafeCompiledQuery({
			sql: EMPTY_WORKLOADS_SQL,
			tenantScope: "org",
			rowSchema: ServiceWorkloadsOutputSchema,
		})
	}

	// Per-service workload identity from the pre-aggregated MV. `max()` over the
	// per-(service, env, hour) winners collapses to the dominant workload, and
	// the multiIf precedence (deployment > statefulset > daemonset) mirrors the
	// classifier used on the metrics side so the JOIN keys line up.
	//
	// Cluster is deliberately NOT projected here: it is sourced from spans, where
	// `k8s.cluster.name` is never tagged (the `k8sattributes` processor doesn't
	// set it), so `K8sCluster` is always ''. The kubeletstats pod gauges DO carry
	// it, so the metrics side below owns clusterName for both the JOIN and display.
	const workloadIdentity = from(ServicePlatformsHourly)
		.select(($) => {
			const deployment = CH.max_($.K8sDeploymentName)
			const statefulSet = CH.max_($.K8sStatefulSetName)
			const daemonSet = CH.max_($.K8sDaemonSetName)
			return {
				serviceName: $.ServiceName,
				workloadKind: CH.multiIf(
					[
						[deployment.neq(""), CH.lit("deployment")],
						[statefulSet.neq(""), CH.lit("statefulset")],
						[daemonSet.neq(""), CH.lit("daemonset")],
					],
					CH.lit("unknown"),
				),
				workloadName: CH.multiIf(
					[
						[deployment.neq(""), deployment],
						[statefulSet.neq(""), statefulSet],
						[daemonSet.neq(""), daemonSet],
					],
					CH.lit(""),
				),
				namespace: CH.max_($.K8sNamespaceName),
			}
		})
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Hour.gte(CH.toStartOfHour(CH.toDateTime(param.dateTime("startTime")))),
			$.Hour.lte(param.dateTime("endTime")),
			CH.inList($.ServiceName, opts.services),
		])
		.groupBy("serviceName")

	// Pod count + CPU/memory limit utilization per workload, from the k8s.pod.*
	// gauges. Keyed by workload identity (kind/name/namespace) so it LEFT JOINs
	// onto the identity rows above. clusterName is NOT a join key — spans never
	// carry it (see workloadIdentity) — so it's aggregated here purely for
	// display and survives the JOIN as the metrics-side value.
	//
	// `k8s.pod.cpu.usage` is emitted by every pod, so it (not the *_utilization
	// gauges, which require CPU/memory limits to be set) drives uniq(pod.uid).
	// The avgIf aggregates still read their own *_utilization rows from the same
	// scan, returning 0/null when a cluster doesn't set the matching limit.
	const workloadMetrics = from(MetricsGauge)
		.select(($) => {
			const deployment = $.ResourceAttributes.get("k8s.deployment.name")
			const statefulSet = $.ResourceAttributes.get("k8s.statefulset.name")
			const daemonSet = $.ResourceAttributes.get("k8s.daemonset.name")
			return {
				workloadKind: CH.multiIf(
					[
						[deployment.neq(""), CH.lit("deployment")],
						[statefulSet.neq(""), CH.lit("statefulset")],
						[daemonSet.neq(""), CH.lit("daemonset")],
					],
					CH.lit("unknown"),
				),
				workloadName: CH.multiIf(
					[
						[deployment.neq(""), deployment],
						[statefulSet.neq(""), statefulSet],
						[daemonSet.neq(""), daemonSet],
					],
					CH.lit(""),
				),
				namespace: $.ResourceAttributes.get("k8s.namespace.name"),
				clusterName: CH.max_($.ResourceAttributes.get("k8s.cluster.name")),
				podCount: CH.uniq($.ResourceAttributes.get("k8s.pod.uid")),
				avgCpuLimitPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.cpu_limit_utilization")),
				avgMemoryLimitPct: CH.avgIf($.Value, $.MetricName.eq("k8s.pod.memory_limit_utilization")),
			}
		})
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			CH.inList($.MetricName, [
				"k8s.pod.cpu.usage",
				"k8s.pod.cpu_limit_utilization",
				"k8s.pod.memory_limit_utilization",
			]),
			$.ResourceAttributes.get("k8s.pod.uid").neq(""),
		])
		.groupBy("workloadKind", "workloadName", "namespace")

	const query = fromQuery(workloadIdentity, "swm")
		.leftJoinQuery(workloadMetrics, "wm", (swm, wm) =>
			swm.workloadKind
				.eq(wm.workloadKind)
				.and(swm.workloadName.eq(wm.workloadName))
				.and(swm.namespace.eq(wm.namespace)),
		)
		.select(($) => ({
			serviceName: $.serviceName,
			workloadKind: $.workloadKind,
			workloadName: $.workloadName,
			namespace: $.namespace,
			// Cluster comes from the metrics side (spans don't carry it). With
			// ClickHouse's default join_use_nulls=0, an unmatched LEFT JOIN row
			// yields '' here, which the non-nullable string schema decodes fine.
			clusterName: $.wm.clusterName,
			// LEFT JOIN ⇒ these are null for services with no pod gauges; the
			// route coerces (`Number(podCount) || 0`, null-checks the averages).
			podCount: $.wm.podCount,
			avgCpuLimitUtilization: $.wm.avgCpuLimitPct,
			avgMemoryLimitUtilization: $.wm.avgMemoryLimitPct,
		}))
		.where(($) => [$.workloadName.neq("")])
		.orderBy(["serviceName", "asc"], ["workloadName", "asc"])
		.limit(500)
		.format("JSON")

	const { sql } = compileCH(query, {
		orgId: params.orgId,
		startTime: params.startTime,
		endTime: params.endTime,
	})

	return unsafeCompiledQuery({ sql, tenantScope: "org", rowSchema: ServiceWorkloadsOutputSchema })
}
