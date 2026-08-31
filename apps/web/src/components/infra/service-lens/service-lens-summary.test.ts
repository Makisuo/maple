import { describe, expect, it } from "vitest"

import {
	deriveLensVerdict,
	lensHeadline,
	lensSubhead,
	SATURATED,
	type LensInput,
} from "./service-lens-summary"
import type { PodRow } from "@/components/infra/pod-table"
import type { ServiceDetailTimeSeriesPoint } from "@/api/warehouse/services"

const pod = (saturation: number, opts?: { unbounded?: boolean }): PodRow =>
	({
		podName: `pod-${saturation}`,
		namespace: "payments",
		nodeName: "ip-10-0-42-17",
		clusterName: "production",
		environment: "production",
		deploymentName: "payments-api",
		statefulsetName: "",
		daemonsetName: "",
		jobName: "",
		qosClass: "Burstable",
		podUid: `uid-${saturation}`,
		computeType: "ec2",
		lastSeen: "2026-08-31 14:00:00",
		cpuUsage: 0.4,
		cpuLimitPct: opts?.unbounded ? 0 : saturation,
		memoryLimitPct: opts?.unbounded ? 0 : 0.5,
		cpuRequestPct: 0.8,
		memoryRequestPct: 0.6,
		cpuUsagePeak: 0.9,
		cpuLimitPctPeak: opts?.unbounded ? 0 : saturation,
		memoryLimitPctPeak: opts?.unbounded ? 0 : 0.5,
		saturation: opts?.unbounded ? 0 : saturation,
	}) as PodRow

const point = (p99: number): ServiceDetailTimeSeriesPoint =>
	({
		bucket: "2026-08-31 14:00:00",
		throughput: 400,
		tracedThroughput: 400,
		hasSampling: false,
		samplingWeight: 1,
		errorRate: 0,
		p50LatencyMs: p99 / 4,
		p95LatencyMs: p99 / 2,
		p99LatencyMs: p99,
		apdexScore: 1,
		totalCount: 100,
		partial: false,
	}) as ServiceDetailTimeSeriesPoint

const series = (values: number[]) => values.map((value, i) => ({ bucket: `b${i}`, value }))

const base: LensInput = { hasWorkload: true, pods: [], points: [], cpuOfLimit: [] }

describe("deriveLensVerdict", () => {
	it("says nothing when the service has no k8s workload", () => {
		expect(deriveLensVerdict({ ...base, hasWorkload: false }).kind).toBe("no-workload")
	})

	it("is healthy when no pod is near a limit", () => {
		const verdict = deriveLensVerdict({ ...base, pods: [pod(0.3), pod(0.5)] })
		expect(verdict).toEqual({ kind: "healthy", podCount: 2, unbounded: 0 })
	})

	// `saturation` is 0 for an idle pod AND for one with no limits, so the
	// healthy verdict would otherwise claim these pods "stayed clear of their
	// limits" when they have none.
	it("does not call unbounded pods healthy", () => {
		const verdict = deriveLensVerdict({
			...base,
			pods: [pod(0, { unbounded: true }), pod(0, { unbounded: true })],
		})
		expect(verdict).toEqual({ kind: "unbounded", podCount: 2, spiked: false })
		expect(lensSubhead(verdict)).not.toContain("stayed below")
	})

	it("still reports the spike when unbounded pods get slow", () => {
		const verdict = deriveLensVerdict({
			...base,
			pods: [pod(0, { unbounded: true })],
			points: [100, 100, 100, 500, 520, 500].map(point),
			cpuOfLimit: series([0, 0, 0, 0, 0, 0]),
		})
		expect(verdict).toEqual({ kind: "unbounded", podCount: 1, spiked: true })
	})

	it("counts unbounded pods separately when only some are", () => {
		const verdict = deriveLensVerdict({
			...base,
			pods: [pod(0.3), pod(0, { unbounded: true })],
		})
		expect(verdict).toEqual({ kind: "healthy", podCount: 2, unbounded: 1 })
		expect(lensSubhead(verdict)).toContain("no limits set")
	})

	it("claims cause only when saturation leads the latency spike", () => {
		const verdict = deriveLensVerdict({
			...base,
			pods: [pod(0.97), pod(0.93), pod(0.4)],
			// Flat, then a 4x spike from bucket 8.
			points: [100, 100, 100, 100, 100, 100, 100, 100, 400, 420, 410, 400].map(point),
			// Saturation crosses at bucket 4 — four buckets of lead.
			cpuOfLimit: series([0.3, 0.4, 0.6, 0.8, 0.95, 0.97, 0.97, 0.96, 0.97, 0.97, 0.97, 0.96]),
		})
		expect(verdict).toEqual({ kind: "throttled-and-slow", saturated: 2, podCount: 3, worst: 0.97 })
	})

	it("will not claim cause when the spike came first", () => {
		const verdict = deriveLensVerdict({
			...base,
			pods: [pod(0.97)],
			// Spikes at bucket 1, long before any saturation.
			points: [100, 400, 420, 410, 400, 400, 400, 400].map(point),
			cpuOfLimit: series([0.2, 0.3, 0.3, 0.4, 0.5, 0.7, 0.9, 0.95]),
		})
		expect(verdict.kind).toBe("throttled")
	})

	it("will not claim cause when saturation only barely leads", () => {
		const verdict = deriveLensVerdict({
			...base,
			pods: [pod(0.95)],
			// Spike at bucket 5, saturation at bucket 4 — one bucket is noise.
			points: [100, 100, 100, 100, 100, 400, 400, 400].map(point),
			cpuOfLimit: series([0.2, 0.3, 0.5, 0.7, 0.92, 0.95, 0.95, 0.95]),
		})
		expect(verdict.kind).toBe("throttled")
	})

	it("blames something else when latency spikes with no saturation", () => {
		const verdict = deriveLensVerdict({
			...base,
			pods: [pod(0.2), pod(0.3)],
			points: [100, 100, 100, 100, 500, 520, 500, 480].map(point),
			cpuOfLimit: series([0.2, 0.2, 0.3, 0.3, 0.3, 0.2, 0.2, 0.3]),
		})
		expect(verdict).toEqual({ kind: "slow-not-throttled", podCount: 2, unbounded: 0 })
	})

	it("does not read a spike out of a window with no traffic", () => {
		// Every p99 is 0, so a ratio test against the baseline would divide the
		// window into "spikes" the moment any value exceeded zero.
		const verdict = deriveLensVerdict({
			...base,
			pods: [pod(0.1)],
			points: [0, 0, 0, 0].map(point),
			cpuOfLimit: series([0, 0, 0, 0]),
		})
		expect(verdict.kind).toBe("healthy")
	})

	it("treats the threshold as inclusive", () => {
		const verdict = deriveLensVerdict({ ...base, pods: [pod(SATURATED)] })
		expect(verdict.kind).toBe("throttled")
	})
})

describe("lens copy", () => {
	it("gives every verdict a headline and a subhead", () => {
		const inputs: LensInput[] = [
			{ ...base, hasWorkload: false },
			{ ...base, pods: [pod(0.2)] },
			{ ...base, pods: [pod(0.95)] },
			{
				...base,
				pods: [pod(0.95)],
				points: [100, 100, 100, 100, 100, 100, 400, 400].map(point),
				cpuOfLimit: series([0.2, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95]),
			},
			{
				...base,
				pods: [pod(0.2)],
				points: [100, 100, 100, 500, 500, 500].map(point),
				cpuOfLimit: series([0.2, 0.2, 0.2, 0.2, 0.2, 0.2]),
			},
			{ ...base, pods: [pod(0, { unbounded: true })] },
		]
		const kinds = new Set(inputs.map((i) => deriveLensVerdict(i).kind))
		expect(kinds.size).toBe(6)

		for (const input of inputs) {
			const verdict = deriveLensVerdict(input)
			expect(lensHeadline(verdict, "payments-api")).toMatch(/\S/)
			expect(lensSubhead(verdict)).toMatch(/\S/)
		}
	})

	it("only says “because” for the verdict that earned it", () => {
		const because = (input: LensInput) =>
			lensHeadline(deriveLensVerdict(input), "payments-api").includes("because")
		expect(because({ ...base, pods: [pod(0.95)] })).toBe(false)
		expect(
			because({
				...base,
				pods: [pod(0.95)],
				points: [100, 100, 100, 100, 100, 100, 400, 400].map(point),
				cpuOfLimit: series([0.2, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95]),
			}),
		).toBe(true)
	})
})
