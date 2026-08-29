import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/clickhouse-builder"
import { compileUnionUnsafe } from "@maple-dev/clickhouse-builder"
import {
	listContainersQuery,
	listContainersSummaryQuery,
	containerDetailSummaryQuery,
	containerCountersSummaryQuery,
	containerGaugeTimeseriesQuery,
	containerSumTimeseriesQuery,
	containerFacetsQuery,
} from "./containers"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
	bucketSeconds: 60,
}

describe("listContainersQuery", () => {
	it("compiles with required filters and the container metric whitelist", () => {
		const { sql } = compileUnsafe(listContainersQuery({}), baseParams)
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("ResourceAttributes['container.name']")
		expect(sql).toContain("container.cpu.utilization")
		expect(sql).toContain("container.memory.percent")
		expect(sql).toContain("container.uptime")
		expect(sql).toContain("container.cpu.limit")
		expect(sql).toContain("LIMIT 50")
		expect(sql).toContain("FORMAT JSON")
		expect(sql).not.toMatch(/__PARAM_\w+__/)
	})

	it("excludes kubeletstats per-container rows via the k8s.pod.name guard", () => {
		const { sql } = compileUnsafe(listContainersQuery({}), baseParams)
		expect(sql).toContain("ResourceAttributes['k8s.pod.name'] = ''")
	})

	it("groups by (containerName, hostName) — names collide across hosts", () => {
		const { sql } = compileUnsafe(listContainersQuery({}), baseParams)
		expect(sql).toContain("GROUP BY containerName, hostName")
	})

	it("normalizes docker's 0..100 percents to the 0..1 scale the pod pages use", () => {
		const { sql } = compileUnsafe(listContainersQuery({}), baseParams)
		expect(sql).toContain(
			"ifNotFinite(avgIf(Value, MetricName = 'container.cpu.utilization'), 0) / 100 AS cpuPct",
		)
		expect(sql).toContain(
			"ifNotFinite(maxIf(Value, MetricName = 'container.memory.percent'), 0) / 100 AS memoryPctPeak",
		)
	})

	it("defaults to worst-first: peak saturation, then peak CPU, then name", () => {
		const { sql } = compileUnsafe(listContainersQuery({}), baseParams)
		expect(sql).toContain(
			"greatest(ifNotFinite(maxIf(Value, MetricName = 'container.cpu.utilization'), 0) / 100, ifNotFinite(maxIf(Value, MetricName = 'container.memory.percent'), 0) / 100) AS saturation",
		)
		expect(sql).toContain("ORDER BY saturation DESC, cpuPctPeak DESC, containerName ASC")
	})

	it("honours an explicit sort key and never drops the tiebreak", () => {
		const { sql } = compileUnsafe(listContainersQuery({ sortBy: "cpuPct", sortDir: "asc" }), baseParams)
		expect(sql).toContain("ORDER BY cpuPct ASC, cpuPctPeak DESC, containerName ASC")
	})

	it("does not repeat the sort key in the tiebreak", () => {
		const { sql } = compileUnsafe(listContainersQuery({ sortBy: "containerName" }), baseParams)
		expect(sql).toContain("ORDER BY containerName ASC, cpuPctPeak DESC")
		expect(sql.match(/containerName (ASC|DESC)/g)).toHaveLength(1)
	})

	it("applies search and multi-value array filters", () => {
		const { sql } = compileUnsafe(
			listContainersQuery({
				search: "redis",
				hostNames: ["host-1", "host-2"],
				images: ["redis:7"],
				composeProjects: ["shop"],
				composeServices: ["cache"],
				environments: ["production"],
			}),
			baseParams,
		)
		expect(sql.toLowerCase()).toContain("position")
		expect(sql).toContain("'redis'")
		expect(sql).toContain("ResourceAttributes['host.name'] IN")
		expect(sql).toContain("ResourceAttributes['container.image.name'] IN")
		expect(sql).toContain("ResourceAttributes['compose.project'] IN")
		expect(sql).toContain("ResourceAttributes['compose.service'] IN")
		expect(sql).toContain(
			"coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN",
		)
		expect(sql).toContain("'production'")
	})

	it("respects custom limit/offset", () => {
		const { sql } = compileUnsafe(listContainersQuery({ limit: 50, offset: 25 }), baseParams)
		expect(sql).toContain("LIMIT 50")
		expect(sql).toContain("OFFSET 25")
	})

	// Scopes filter on aggregates, which a WHERE over raw rows cannot express.
	it("filters the saturated scope outside the grouping", () => {
		const { sql } = compileUnsafe(listContainersQuery({ scope: "saturated" }), baseParams)
		expect(sql).toContain("GROUP BY containerName, hostName) AS containers")
		expect(sql).toContain("WHERE saturation >= 0.9")
	})

	it("scopes stale containers relative to the window end, not wall-clock now", () => {
		const { sql } = compileUnsafe(listContainersQuery({ scope: "stale" }), baseParams)
		expect(sql).toContain("WHERE lastSeen < '2024-01-02 00:00:00' - INTERVAL 300 SECOND")
		expect(sql).not.toMatch(/__PARAM_\w+__/)
	})

	it("emits no scope predicate when none is asked for", () => {
		const { sql } = compileUnsafe(listContainersQuery({}), baseParams)
		expect(sql).not.toContain("saturation >= 0.9")
	})
})

describe("listContainersSummaryQuery", () => {
	it("aggregates per container first so the band counts are exact, not HLL estimates", () => {
		const { sql } = compileUnsafe(listContainersSummaryQuery({}), baseParams)
		expect(sql).toContain("GROUP BY containerName, hostName")
		expect(sql).toContain("count() AS totalContainers")
		expect(sql).toContain("countIf(saturation >= 0.9) AS saturatedContainers")
		expect(sql).toContain("countIf((saturation >= 0.6 AND saturation < 0.9)) AS elevatedContainers")
		expect(sql).not.toContain("uniq(")
		expect(sql).not.toMatch(/__PARAM_\w+__/)
	})

	it("accepts the same filter set as the list", () => {
		const { sql } = compileUnsafe(
			listContainersSummaryQuery({ hostNames: ["host-1"], search: "api" }),
			baseParams,
		)
		expect(sql).toContain("'host-1'")
		expect(sql).toContain("'api'")
		expect(sql).toContain("OrgId = 'org_1'")
	})
})

describe("containerFacetsQuery", () => {
	it("emits a UNION ALL with one branch per facet dimension", () => {
		const { sql } = compileUnionUnsafe(containerFacetsQuery({}), baseParams)
		expect(sql.toUpperCase().split("UNION ALL").length).toBe(6)
		expect(sql).toContain("ResourceAttributes['container.name']")
		expect(sql).toContain("ResourceAttributes['host.name']")
		expect(sql).toContain("ResourceAttributes['container.image.name']")
		expect(sql).toContain("ResourceAttributes['compose.project']")
		expect(sql).toContain("ResourceAttributes['compose.service']")
		expect(sql).toContain(
			"coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment'])",
		)
		expect(sql).toContain("FORMAT JSON")
	})

	it("counts by container.id — recreated containers keep their name, not their id", () => {
		const { sql } = compileUnionUnsafe(containerFacetsQuery({}), baseParams)
		expect(sql).toContain("uniq(ResourceAttributes['container.id'])")
	})

	it("propagates active filters into facet counts", () => {
		const { sql } = compileUnionUnsafe(containerFacetsQuery({ hostNames: ["host-1"] }), baseParams)
		expect(sql).toContain("'host-1'")
	})

	it("scans only the single probe metric, not the full container metric set", () => {
		const { sql } = compileUnionUnsafe(containerFacetsQuery({}), baseParams)
		expect(sql).toContain("MetricName IN ('container.cpu.utilization')")
		expect(sql).not.toContain("container.memory.percent")
		expect(sql).not.toContain("container.uptime")
	})
})

describe("containerDetailSummaryQuery", () => {
	it("filters by container name with optional host narrowing", () => {
		const { sql } = compileUnsafe(
			containerDetailSummaryQuery({ containerName: "redis", hostName: "host-1" }),
			baseParams,
		)
		expect(sql).toContain("'redis'")
		expect(sql).toContain("ResourceAttributes['host.name'] = 'host-1'")
		expect(sql).toContain("ResourceAttributes['k8s.pod.name'] = ''")
	})

	it("omits the host narrowing when not asked for", () => {
		const { sql } = compileUnsafe(containerDetailSummaryQuery({ containerName: "redis" }), baseParams)
		expect(sql).not.toContain("ResourceAttributes['host.name'] =")
	})
})

describe("containerCountersSummaryQuery", () => {
	it("reads the counter metrics from metrics_sum", () => {
		const { sql } = compileUnsafe(containerCountersSummaryQuery({ containerName: "redis" }), baseParams)
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).toContain("container.memory.usage.total")
		expect(sql).toContain("container.memory.usage.limit")
		expect(sql).toContain("container.pids.count")
	})

	it("computes the restart window delta from the cumulative counter", () => {
		const { sql } = compileUnsafe(containerCountersSummaryQuery({ containerName: "redis" }), baseParams)
		expect(sql).toContain(
			"ifNotFinite(maxIf(Value, MetricName = 'container.restarts') - minIf(Value, MetricName = 'container.restarts'), 0) AS restartsDelta",
		)
	})
})

describe("containerGaugeTimeseriesQuery", () => {
	it("buckets by toStartOfInterval and filters by metric name", () => {
		const { sql } = compileUnsafe(
			containerGaugeTimeseriesQuery({
				containerName: "redis",
				metricName: "container.cpu.utilization",
				divideBy: 100,
			}),
			baseParams,
		)
		expect(sql).toContain("toStartOfInterval")
		expect(sql).toContain("INTERVAL 60 SECOND")
		expect(sql).toContain("MetricName = 'container.cpu.utilization'")
		expect(sql).toContain("avg(Value) / 100")
	})

	it("leaves non-percent gauges unscaled", () => {
		const { sql } = compileUnsafe(
			containerGaugeTimeseriesQuery({ containerName: "redis", metricName: "container.uptime" }),
			baseParams,
		)
		expect(sql).not.toContain("/ 100")
	})
})

describe("containerSumTimeseriesQuery", () => {
	it("labels series from metric names for the rx/tx network split", () => {
		const { sql } = compileUnsafe(
			containerSumTimeseriesQuery({
				containerName: "redis",
				metricNames: ["container.network.io.usage.rx_bytes", "container.network.io.usage.tx_bytes"],
				metricLabels: [
					["container.network.io.usage.rx_bytes", "receive"],
					["container.network.io.usage.tx_bytes", "transmit"],
				],
			}),
			baseParams,
		)
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).toContain("multiIf")
		expect(sql).toContain("'receive'")
		expect(sql).toContain("'transmit'")
	})

	it("groups block IO by the operation datapoint attribute", () => {
		const { sql } = compileUnsafe(
			containerSumTimeseriesQuery({
				containerName: "redis",
				metricNames: ["container.blockio.io_service_bytes_recursive"],
				groupByAttributeKey: "operation",
			}),
			baseParams,
		)
		expect(sql).toContain("Attributes['operation']")
		expect(sql).toContain("GROUP BY bucket, attributeValue")
	})
})

describe("container facet exclusions", () => {
	it("emits NOT IN for every excluded dimension", () => {
		const { sql } = compileUnsafe(
			listContainersQuery({
				excludedContainerNames: ["noisy"],
				excludedHostNames: ["host-9"],
				excludedImages: ["nginx:latest"],
				excludedComposeProjects: ["scratch"],
				excludedComposeServices: ["worker"],
				excludedEnvironments: ["staging"],
			}),
			baseParams,
		)
		for (const value of ["noisy", "host-9", "nginx:latest", "scratch", "worker", "staging"]) {
			expect(sql).toContain(`NOT IN ('${value}')`)
		}
	})

	it("combines with the inclusion on the same dimension", () => {
		const { sql } = compileUnsafe(
			listContainersQuery({ hostNames: ["host-1", "host-2"], excludedHostNames: ["host-9"] }),
			baseParams,
		)
		expect(sql).toContain("IN ('host-1', 'host-2')")
		expect(sql).toContain("NOT IN ('host-9')")
	})
})

// Same NaN hazard as the pod queries: a container with no limit emits no
// cpu.limit samples, so unguarded avgIf/maxIf would serialize null and fail
// the numeric decode for the whole page.
describe("conditional aggregates are NaN-guarded", () => {
	const queries: ReadonlyArray<[string, string]> = [
		["listContainersQuery", compileUnsafe(listContainersQuery({}), baseParams).sql],
		["listContainersSummaryQuery", compileUnsafe(listContainersSummaryQuery({}), baseParams).sql],
		[
			"containerDetailSummaryQuery",
			compileUnsafe(containerDetailSummaryQuery({ containerName: "c1" }), baseParams).sql,
		],
		[
			"containerCountersSummaryQuery",
			compileUnsafe(containerCountersSummaryQuery({ containerName: "c1" }), baseParams).sql,
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
