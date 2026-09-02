import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/clickhouse-builder"
import { compileUnionUnsafe } from "@maple-dev/clickhouse-builder"
import {
	listHostsQuery,
	hostDetailSummaryQuery,
	fleetUtilizationTimeseriesQuery,
	listPodsQuery,
	listPodsSummaryQuery,
	podDetailSummaryQuery,
	podGaugeTimeseriesQuery,
	podFacetsQuery,
	listNodesQuery,
	nodeDetailSummaryQuery,
	nodeGaugeTimeseriesQuery,
	nodeFacetsQuery,
	listWorkloadsQuery,
	workloadDetailSummaryQuery,
	workloadGaugeTimeseriesQuery,
	workloadFacetsQuery,
	infraPresenceQuery,
} from "./infra"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
	bucketSeconds: 60,
}

describe("listHostsQuery (sanity)", () => {
	it("compiles with required filters", () => {
		const { sql } = compileUnsafe(listHostsQuery({}), baseParams)
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("ResourceAttributes['host.name']")
		expect(sql).not.toMatch(/__PARAM_\w+__/)
	})
})

describe("hostDetailSummaryQuery (sanity)", () => {
	it("filters by hostName", () => {
		const { sql } = compileUnsafe(hostDetailSummaryQuery({ hostName: "host-1" }), baseParams)
		expect(sql).toContain("ResourceAttributes['host.name']")
		expect(sql).toContain("'host-1'")
	})
})

describe("listPodsQuery", () => {
	it("compiles with required filters and pod metric whitelist", () => {
		const { sql } = compileUnsafe(listPodsQuery({}), baseParams)
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("ResourceAttributes['k8s.pod.name']")
		expect(sql).toContain("k8s.pod.cpu.usage")
		expect(sql).toContain("k8s.pod.cpu_limit_utilization")
		expect(sql).toContain("k8s.pod.memory_limit_utilization")
		expect(sql).toContain("k8s.pod.cpu_request_utilization")
		expect(sql).toContain("k8s.pod.memory_request_utilization")
		expect(sql).toContain("LIMIT 50")
		expect(sql).toContain("FORMAT JSON")
		expect(sql).not.toMatch(/__PARAM_\w+__/)
	})

	it("defaults to worst-first: peak saturation, then peak CPU for unlimited pods", () => {
		const { sql } = compileUnsafe(listPodsQuery({}), baseParams)
		expect(sql).toContain(
			"greatest(ifNotFinite(maxIf(Value, MetricName = 'k8s.pod.cpu_limit_utilization'), 0), ifNotFinite(maxIf(Value, MetricName = 'k8s.pod.memory_limit_utilization'), 0)) AS saturation",
		)
		expect(sql).toContain("ORDER BY saturation DESC, cpuUsagePeak DESC, podName ASC")
		expect(sql).not.toContain("ORDER BY lastSeen")
	})

	it("selects peaks alongside averages so a row can show avg → peak", () => {
		const { sql } = compileUnsafe(listPodsQuery({}), baseParams)
		expect(sql).toContain("ifNotFinite(avgIf(Value, MetricName = 'k8s.pod.cpu.usage'), 0) AS cpuUsage")
		expect(sql).toContain(
			"ifNotFinite(maxIf(Value, MetricName = 'k8s.pod.cpu.usage'), 0) AS cpuUsagePeak",
		)
	})

	it("honours an explicit sort key and never drops the tiebreak", () => {
		const { sql } = compileUnsafe(listPodsQuery({ sortBy: "cpuUsage", sortDir: "asc" }), baseParams)
		expect(sql).toContain("ORDER BY cpuUsage ASC, cpuUsagePeak DESC, podName ASC")
	})

	it("does not repeat the sort key in the tiebreak", () => {
		const { sql } = compileUnsafe(listPodsQuery({ sortBy: "podName" }), baseParams)
		// podName defaults to ascending and must appear exactly once.
		expect(sql).toContain("ORDER BY podName ASC, cpuUsagePeak DESC")
		expect(sql.match(/podName (ASC|DESC)/g)).toHaveLength(1)
	})

	it("applies search and single-node legacy filters", () => {
		const { sql } = compileUnsafe(
			listPodsQuery({
				search: "auth",
				namespaces: ["prod"],
				nodeNames: ["node-7"],
			}),
			baseParams,
		)
		expect(sql.toLowerCase()).toContain("position")
		expect(sql).toContain("'auth'")
		expect(sql).toContain("'prod'")
		expect(sql).toContain("'node-7'")
	})

	it("applies multi-value array filters with IN clauses", () => {
		const { sql } = compileUnsafe(
			listPodsQuery({
				namespaces: ["prod", "stage"],
				nodeNames: ["node-1", "node-2"],
				clusters: ["c1"],
				deployments: ["api", "web"],
				environments: ["production"],
			}),
			baseParams,
		)
		expect(sql).toContain("ResourceAttributes['k8s.namespace.name'] IN")
		expect(sql).toContain("'prod'")
		expect(sql).toContain("'stage'")
		expect(sql).toContain("ResourceAttributes['k8s.node.name'] IN")
		expect(sql).toContain("ResourceAttributes['k8s.cluster.name'] IN")
		expect(sql).toContain("ResourceAttributes['k8s.deployment.name'] IN")
		expect(sql).toContain(
			"coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN",
		)
		expect(sql).toContain("'production'")
	})

	it("filters by pod, statefulset, daemonset, and job names when arrays present", () => {
		const { sql } = compileUnsafe(
			listPodsQuery({
				podNames: ["pod-a"],
				statefulsets: ["sts-x"],
				daemonsets: ["ds-y"],
				jobs: ["job-z"],
			}),
			baseParams,
		)
		expect(sql).toContain("ResourceAttributes['k8s.pod.name'] IN")
		expect(sql).toContain("ResourceAttributes['k8s.statefulset.name'] IN")
		expect(sql).toContain("ResourceAttributes['k8s.daemonset.name'] IN")
		expect(sql).toContain("ResourceAttributes['k8s.job.name'] IN")
	})

	it("applies workload filter when both kind+name supplied (legacy)", () => {
		const { sql } = compileUnsafe(
			listPodsQuery({
				workloadKind: "deployment",
				workloadName: "checkout",
			}),
			baseParams,
		)
		expect(sql).toContain("ResourceAttributes['k8s.deployment.name']")
		expect(sql).toContain("'checkout'")
	})

	it("respects custom limit/offset", () => {
		const { sql } = compileUnsafe(listPodsQuery({ limit: 50, offset: 25 }), baseParams)
		expect(sql).toContain("LIMIT 50")
		expect(sql).toContain("OFFSET 25")
	})

	// Scopes filter on aggregates, which a WHERE over raw rows cannot express.
	it("filters the saturated scope outside the grouping", () => {
		const { sql } = compileUnsafe(listPodsQuery({ scope: "saturated" }), baseParams)
		expect(sql).toContain("GROUP BY podName) AS pods")
		expect(sql).toContain("WHERE saturation >= 0.9")
	})

	it("treats a pod with no limit metrics as unbounded, not as healthy", () => {
		const { sql } = compileUnsafe(listPodsQuery({ scope: "unbounded" }), baseParams)
		expect(sql).toContain("WHERE (saturation = 0 AND cpuUsagePeak > 0)")
	})

	it("scopes stale pods relative to the window end, not wall-clock now", () => {
		const { sql } = compileUnsafe(listPodsQuery({ scope: "stale" }), baseParams)
		expect(sql).toContain("WHERE lastSeen < '2024-01-02 00:00:00' - INTERVAL 300 SECOND")
		expect(sql).not.toMatch(/__PARAM_\w+__/)
	})

	it("emits no scope predicate when none is asked for", () => {
		const { sql } = compileUnsafe(listPodsQuery({}), baseParams)
		expect(sql).not.toContain("saturation >= 0.9")
		expect(sql).not.toContain("cpuUsagePeak > 0")
	})
})

describe("listPodsSummaryQuery", () => {
	it("aggregates per pod first so the band counts are exact, not HLL estimates", () => {
		const { sql } = compileUnsafe(listPodsSummaryQuery({}), baseParams)
		expect(sql).toContain("GROUP BY podName")
		expect(sql).toContain("count() AS totalPods")
		expect(sql).toContain("countIf(saturation >= 0.9) AS saturatedPods")
		expect(sql).toContain("countIf((saturation >= 0.6 AND saturation < 0.9)) AS elevatedPods")
		expect(sql).not.toContain("uniq(")
		expect(sql).not.toMatch(/__PARAM_\w+__/)
	})

	it("counts unbounded pods as burning CPU with no limit samples at all", () => {
		const { sql } = compileUnsafe(listPodsSummaryQuery({}), baseParams)
		expect(sql).toContain("countIf((limitSamples = 0 AND cpuUsagePeak > 0)) AS unboundedPods")
	})

	// The browse band deliberately passes only the *scope* (cluster/env) so it can
	// show what the row filters excluded, but the query itself accepts the full
	// filter set so callers that do want an exact match can ask for one.
	it("accepts the same filter set as the list", () => {
		const { sql } = compileUnsafe(
			listPodsSummaryQuery({ namespaces: ["payments"], search: "api" }),
			baseParams,
		)
		expect(sql).toContain("'payments'")
		expect(sql).toContain("'api'")
		expect(sql).toContain("OrgId = 'org_1'")
	})
})

describe("podFacetsQuery", () => {
	it("emits a UNION ALL with one branch per facet dimension", () => {
		const { sql } = compileUnionUnsafe(podFacetsQuery({}), baseParams)
		expect(sql.toUpperCase().split("UNION ALL").length).toBeGreaterThan(2)
		expect(sql).toContain("ResourceAttributes['k8s.pod.name']")
		expect(sql).toContain("ResourceAttributes['k8s.namespace.name']")
		expect(sql).toContain("ResourceAttributes['k8s.node.name']")
		expect(sql).toContain("ResourceAttributes['k8s.cluster.name']")
		expect(sql).toContain("ResourceAttributes['k8s.deployment.name']")
		expect(sql).toContain("ResourceAttributes['k8s.statefulset.name']")
		expect(sql).toContain("ResourceAttributes['k8s.daemonset.name']")
		expect(sql).toContain("ResourceAttributes['k8s.job.name']")
		expect(sql).toContain(
			"coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment'])",
		)
		expect(sql).toContain("FORMAT JSON")
	})

	it("propagates active filters into facet counts", () => {
		const { sql } = compileUnionUnsafe(podFacetsQuery({ namespaces: ["prod"] }), baseParams)
		expect(sql).toContain("'prod'")
	})

	it("scans only the single probe metric, not the full pod metric set", () => {
		const { sql } = compileUnionUnsafe(podFacetsQuery({}), baseParams)
		expect(sql).toContain("MetricName IN ('k8s.pod.cpu.usage')")
		expect(sql).not.toContain("k8s.pod.cpu_limit_utilization")
		expect(sql).not.toContain("k8s.pod.cpu_request_utilization")
		expect(sql).not.toContain("k8s.pod.memory_limit_utilization")
		expect(sql).not.toContain("k8s.pod.memory_request_utilization")
	})
})

describe("podDetailSummaryQuery", () => {
	it("filters by pod name and aggregates request+limit utilization", () => {
		const { sql } = compileUnsafe(
			podDetailSummaryQuery({ podName: "pod-xyz", namespace: "prod" }),
			baseParams,
		)
		expect(sql).toContain("'pod-xyz'")
		expect(sql).toContain("'prod'")
		expect(sql).toContain("k8s.pod.cpu_request_utilization")
		expect(sql).toContain("k8s.pod.memory_request_utilization")
	})
})

describe("podGaugeTimeseriesQuery", () => {
	it("buckets by toStartOfInterval and filters by metric name", () => {
		const { sql } = compileUnsafe(
			podGaugeTimeseriesQuery({
				podName: "pod-xyz",
				metricName: "k8s.pod.cpu.usage",
			}),
			baseParams,
		)
		expect(sql).toContain("toStartOfInterval")
		expect(sql).toContain("INTERVAL 60 SECOND")
		expect(sql).toContain("MetricName = 'k8s.pod.cpu.usage'")
	})
})

describe("listNodesQuery", () => {
	it("filters out pod-scoped rows so node aggregates are clean", () => {
		const { sql } = compileUnsafe(listNodesQuery({}), baseParams)
		expect(sql).toContain("ResourceAttributes['k8s.node.name']")
		expect(sql).toContain("ResourceAttributes['k8s.pod.name'] = ''")
		expect(sql).toContain("k8s.node.cpu.usage")
		expect(sql).toContain("k8s.node.uptime")
		expect(sql).not.toMatch(/__PARAM_\w+__/)
	})

	it("applies cluster/environment array filters", () => {
		const { sql } = compileUnsafe(
			listNodesQuery({
				clusters: ["c1", "c2"],
				environments: ["production"],
			}),
			baseParams,
		)
		expect(sql).toContain("ResourceAttributes['k8s.cluster.name'] IN")
		expect(sql).toContain(
			"coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN",
		)
	})
})

describe("nodeFacetsQuery", () => {
	it("emits node, cluster, and environment facet branches", () => {
		const { sql } = compileUnionUnsafe(nodeFacetsQuery({}), baseParams)
		expect(sql.toUpperCase().split("UNION ALL").length).toBeGreaterThan(2)
		expect(sql).toContain("ResourceAttributes['k8s.node.name']")
		expect(sql).toContain("ResourceAttributes['k8s.cluster.name']")
		expect(sql).toContain(
			"coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment'])",
		)
	})

	it("scans only k8s.node.cpu.usage, not k8s.node.uptime", () => {
		const { sql } = compileUnionUnsafe(nodeFacetsQuery({}), baseParams)
		expect(sql).toContain("MetricName IN ('k8s.node.cpu.usage')")
		expect(sql).not.toContain("k8s.node.uptime")
	})
})

describe("nodeDetailSummaryQuery", () => {
	it("filters by node name", () => {
		const { sql } = compileUnsafe(nodeDetailSummaryQuery({ nodeName: "node-7" }), baseParams)
		expect(sql).toContain("'node-7'")
		expect(sql).toContain("ResourceAttributes['k8s.pod.name'] = ''")
	})
})

describe("nodeGaugeTimeseriesQuery", () => {
	it("compiles bucketed node timeseries", () => {
		const { sql } = compileUnsafe(
			nodeGaugeTimeseriesQuery({
				nodeName: "node-7",
				metricName: "k8s.node.cpu.usage",
			}),
			baseParams,
		)
		expect(sql).toContain("toStartOfInterval")
		expect(sql).toContain("MetricName = 'k8s.node.cpu.usage'")
		expect(sql).toContain("'node-7'")
	})
})

// Workloads

describe("listWorkloadsQuery", () => {
	it("groups by k8s.deployment.name when kind = deployment", () => {
		const { sql } = compileUnsafe(listWorkloadsQuery({ kind: "deployment" }), baseParams)
		expect(sql).toContain("ResourceAttributes['k8s.deployment.name']")
		expect(sql).toContain("uniq")
	})

	it("uses the right attribute for statefulset and daemonset", () => {
		const sts = compileUnsafe(listWorkloadsQuery({ kind: "statefulset" }), baseParams).sql
		expect(sts).toContain("ResourceAttributes['k8s.statefulset.name']")
		const ds = compileUnsafe(listWorkloadsQuery({ kind: "daemonset" }), baseParams).sql
		expect(ds).toContain("ResourceAttributes['k8s.daemonset.name']")
	})

	it("applies workloadNames + namespaces + clusters filters", () => {
		const { sql } = compileUnsafe(
			listWorkloadsQuery({
				kind: "deployment",
				workloadNames: ["api"],
				namespaces: ["prod"],
				clusters: ["c1"],
				environments: ["production"],
			}),
			baseParams,
		)
		expect(sql).toContain("ResourceAttributes['k8s.deployment.name'] IN")
		expect(sql).toContain("ResourceAttributes['k8s.namespace.name'] IN")
		expect(sql).toContain("ResourceAttributes['k8s.cluster.name'] IN")
		expect(sql).toContain(
			"coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN",
		)
	})
})

describe("workloadFacetsQuery", () => {
	it("emits workload, namespace, cluster, environment branches scoped to kind", () => {
		const { sql } = compileUnionUnsafe(workloadFacetsQuery({ kind: "deployment" }), baseParams)
		expect(sql).toContain("ResourceAttributes['k8s.deployment.name']")
		expect(sql).toContain("ResourceAttributes['k8s.namespace.name']")
		expect(sql).toContain("ResourceAttributes['k8s.cluster.name']")
		expect(sql).toContain(
			"coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment'])",
		)
	})

	it("scans only the single probe metric, not the full pod metric set", () => {
		const { sql } = compileUnionUnsafe(workloadFacetsQuery({ kind: "deployment" }), baseParams)
		expect(sql).toContain("MetricName IN ('k8s.pod.cpu.usage')")
		expect(sql).not.toContain("k8s.pod.memory_limit_utilization")
		expect(sql).not.toContain("k8s.pod.cpu_request_utilization")
	})
})

describe("workloadDetailSummaryQuery", () => {
	it("filters by workload name and namespace", () => {
		const { sql } = compileUnsafe(
			workloadDetailSummaryQuery({
				kind: "deployment",
				workloadName: "checkout",
				namespace: "prod",
			}),
			baseParams,
		)
		expect(sql).toContain("'checkout'")
		expect(sql).toContain("'prod'")
	})
})

describe("workloadGaugeTimeseriesQuery", () => {
	it("includes per-pod breakdown when groupByPod = true", () => {
		const { sql } = compileUnsafe(
			workloadGaugeTimeseriesQuery({
				kind: "deployment",
				workloadName: "checkout",
				metricName: "k8s.pod.cpu_limit_utilization",
				groupByPod: true,
			}),
			baseParams,
		)
		expect(sql).toContain("ResourceAttributes['k8s.pod.name']")
		expect(sql).toContain("GROUP BY")
	})

	it("aggregates across pods when groupByPod = false", () => {
		const { sql } = compileUnsafe(
			workloadGaugeTimeseriesQuery({
				kind: "deployment",
				workloadName: "checkout",
				metricName: "k8s.pod.cpu_limit_utilization",
			}),
			baseParams,
		)
		expect(sql).toContain("toStartOfInterval")
	})
})

describe("pod facet exclusions", () => {
	it("emits NOT IN for every excluded dimension", () => {
		// Ten dimensions drive off one table, so this is the test that catches a facet added to the
		// include list and forgotten in the exclude list.
		const { sql } = compileUnsafe(
			listPodsQuery({
				excludedPodNames: ["noisy-pod"],
				excludedNamespaces: ["kube-system"],
				excludedNodeNames: ["node-1"],
				excludedClusters: ["staging-cluster"],
				excludedDeployments: ["canary"],
				excludedStatefulsets: ["etcd"],
				excludedDaemonsets: ["fluentd"],
				excludedJobs: ["backfill"],
				excludedEnvironments: ["staging"],
				excludedComputeTypes: ["fargate"],
			}),
			baseParams,
		)
		for (const value of [
			"noisy-pod",
			"kube-system",
			"node-1",
			"staging-cluster",
			"canary",
			"etcd",
			"fluentd",
			"backfill",
			"staging",
			"fargate",
		]) {
			expect(sql).toContain(`NOT IN ('${value}')`)
		}
	})

	it("combines with the inclusion on the same dimension", () => {
		const { sql } = compileUnsafe(
			listPodsQuery({ namespaces: ["default", "web"], excludedNamespaces: ["kube-system"] }),
			baseParams,
		)
		expect(sql).toContain("IN ('default', 'web')")
		expect(sql).toContain("NOT IN ('kube-system')")
	})
})

// A pod with no CPU limit set emits no `cpu_limit_utilization` samples at all,
// so `avgIf`/`maxIf` over that family returns `nan` — which ClickHouse
// serializes as JSON `null`, failing the numeric row schema and 502-ing the
// whole page rather than the one row. Every conditional aggregate here has to
// carry its `ifNotFinite` guard, so this sweeps them rather than spot-checking.
describe("conditional aggregates are NaN-guarded", () => {
	const queries: ReadonlyArray<[string, string]> = [
		["listHostsQuery", compileUnsafe(listHostsQuery({}), baseParams).sql],
		["hostDetailSummaryQuery", compileUnsafe(hostDetailSummaryQuery({ hostName: "h1" }), baseParams).sql],
		["fleetUtilizationTimeseriesQuery", compileUnsafe(fleetUtilizationTimeseriesQuery(), baseParams).sql],
		["listPodsQuery", compileUnsafe(listPodsQuery({}), baseParams).sql],
		["listPodsSummaryQuery", compileUnsafe(listPodsSummaryQuery({}), baseParams).sql],
		["podDetailSummaryQuery", compileUnsafe(podDetailSummaryQuery({ podName: "p1" }), baseParams).sql],
		["listNodesQuery", compileUnsafe(listNodesQuery({}), baseParams).sql],
		["nodeDetailSummaryQuery", compileUnsafe(nodeDetailSummaryQuery({ nodeName: "n1" }), baseParams).sql],
		["listWorkloadsQuery", compileUnsafe(listWorkloadsQuery({ kind: "deployment" }), baseParams).sql],
		[
			"workloadDetailSummaryQuery",
			compileUnsafe(workloadDetailSummaryQuery({ kind: "deployment", workloadName: "w1" }), baseParams)
				.sql,
		],
	]

	for (const [name, sql] of queries) {
		it(`${name} wraps every avgIf/maxIf in ifNotFinite`, () => {
			const unguarded = [...sql.matchAll(/(?:^|[^(])\b(avgIf|maxIf)\(/g)]
			expect(unguarded, `unguarded conditional aggregate in ${name}`).toEqual([])
			expect(sql).toMatch(/ifNotFinite\((?:avgIf|maxIf)\(/)
		})
	}
})

// The probe runs on every page load, gating which Infrastructure rows the
// sidebar shows. Its whole justification is being cheaper than the list
// queries — an aggregate anywhere in it reads the full match set before the
// LIMIT can trim anything, which would quietly undo that.
describe("infraPresenceQuery", () => {
	const { sql } = compileUnionUnsafe(infraPresenceQuery(), baseParams)

	it("probes every sidebar surface", () => {
		for (const surface of ["hosts", "containers", "k8sPods", "k8sNodes", "k8sWorkloads"]) {
			expect(sql).toContain(`'${surface}' AS surface`)
		}
		expect(sql).not.toMatch(/__PARAM_\w+__/)
	})

	it("short-circuits each branch instead of aggregating", () => {
		expect(sql).not.toMatch(/\b(count|uniq|sum|avg|max|min)\w*\(/)
		expect(sql.match(/LIMIT 1/g)).toHaveLength(5)
	})

	it("scopes every branch to the org and the caller's window", () => {
		expect(sql.match(/OrgId = 'org_1'/g)).toHaveLength(5)
		expect(sql.match(/TimeUnix >= /g)).toHaveLength(5)
		expect(sql.match(/TimeUnix <= /g)).toHaveLength(5)
	})

	it("pins one probe metric per branch rather than the surface's full set", () => {
		expect(sql.match(/MetricName = /g)).toHaveLength(5)
		expect(sql).not.toContain("MetricName IN")
	})

	it("counts a pod's workload present under any of the three owner kinds", () => {
		for (const key of ["k8s.deployment.name", "k8s.statefulset.name", "k8s.daemonset.name"]) {
			expect(sql).toContain(`ResourceAttributes['${key}']`)
		}
	})
})
