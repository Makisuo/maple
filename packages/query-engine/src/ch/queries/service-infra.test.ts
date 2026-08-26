import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { serviceWorkloadsSQL } from "./service-infra"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

describe("serviceWorkloadsSQL", () => {
	it.effect("decodes workload rows with numeric strings and nullable utilization", () =>
		Effect.gen(function* () {
			const compiled = yield* serviceWorkloadsSQL({ services: ["checkout-api"] }, baseParams)

			const rows = yield* compiled.decodeRows([
				{
					serviceName: "checkout-api",
					workloadKind: "deployment",
					workloadName: "checkout-api",
					namespace: "default",
					clusterName: "prod",
					podCount: "4",
					avgCpuLimitUtilization: "0.42",
					avgMemoryLimitUtilization: null,
				},
			])

			expect(rows).toEqual([
				{
					serviceName: "checkout-api",
					workloadKind: "deployment",
					workloadName: "checkout-api",
					namespace: "default",
					clusterName: "prod",
					podCount: 4,
					avgCpuLimitUtilization: 0.42,
					avgMemoryLimitUtilization: null,
				},
			])
		}),
	)

	it.effect("fails decoding unknown workload kinds", () =>
		Effect.gen(function* () {
			const compiled = yield* serviceWorkloadsSQL({ services: ["checkout-api"] }, baseParams)

			const exit = yield* Effect.exit(
				compiled.decodeRows([
					{
						serviceName: "checkout-api",
						workloadKind: "cronjob",
						workloadName: "checkout-api",
						namespace: "default",
						clusterName: "prod",
						podCount: 4,
						avgCpuLimitUtilization: 0.42,
						avgMemoryLimitUtilization: 0.5,
					},
				]),
			)

			expect(Exit.isFailure(exit)).toBe(true)
		}),
	)

	it("does not join workloads on clusterName and probes pods via cpu.usage", () => {
		const { sql } = Effect.runSync(serviceWorkloadsSQL({ services: ["checkout-api"] }, baseParams))

		// Regression: spans never carry k8s.cluster.name, so joining on it dropped
		// every row and pod counts always read 0. The identity side must not
		// project a cluster column and the JOIN must not key on it.
		expect(sql).not.toContain("swm.clusterName")
		expect(sql).not.toContain("K8sCluster")

		// cluster is sourced from the metrics side for display only.
		expect(sql).toContain("wm.clusterName AS clusterName")

		// pods are counted via the always-emitted usage metric, not only the
		// limit-utilization gauges (which require limits to be set).
		expect(sql).toContain("'k8s.pod.cpu.usage'")
	})

	it.effect("empty-service short circuit still carries the workload row schema", () =>
		Effect.gen(function* () {
			const compiled = yield* serviceWorkloadsSQL({ services: [] }, baseParams)

			const rows = yield* compiled.decodeRows([
				{
					serviceName: "checkout-api",
					workloadKind: "unknown",
					workloadName: "",
					namespace: "",
					clusterName: "",
					podCount: "0",
					avgCpuLimitUtilization: null,
					avgMemoryLimitUtilization: null,
				},
			])

			expect(rows).toEqual([
				{
					serviceName: "checkout-api",
					workloadKind: "unknown",
					workloadName: "",
					namespace: "",
					clusterName: "",
					podCount: 0,
					avgCpuLimitUtilization: null,
					avgMemoryLimitUtilization: null,
				},
			])
		}),
	)
})
