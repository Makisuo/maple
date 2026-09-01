import { describe, expect, it } from "vitest"

import {
	deriveLensVerdict,
	lensHeadline,
	lensSubhead,
	SATURATED,
	type LensInput,
} from "./service-lens-summary"
import type { PodRow } from "@/components/infra/pod-table"

const pod = (saturation: number, opts?: { unbounded?: boolean }): PodRow =>
	({
		podName: `pod-${saturation}-${opts?.unbounded ? "u" : "b"}`,
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

const BUCKET_SECONDS = 300
/** Bucket `i` as the normalized ISO string the page feeds in. */
const at = (i: number) => new Date(Date.UTC(2026, 7, 31, 10, 0, 0) + i * BUCKET_SECONDS * 1000).toISOString()

/** A dense, fully-served latency series. */
const latency = (values: number[], opts?: { servedFrom?: number; servedTo?: number }) =>
	values.map((value, i) => ({
		bucket: at(i),
		value,
		hasTraffic: i >= (opts?.servedFrom ?? 0) && i <= (opts?.servedTo ?? values.length - 1),
	}))

/** A CPU series at explicit bucket indices — sparse, as the gauges really are. */
const cpu = (entries: ReadonlyArray<[index: number, value: number]>) =>
	entries.map(([i, value]) => ({ bucket: at(i), value }))

const base: LensInput = {
	hasWorkload: true,
	pods: [],
	totalPods: 0,
	latency: [],
	cpuOfLimit: [],
	bucketSeconds: BUCKET_SECONDS,
}

const withPods = (pods: PodRow[], extra?: Partial<LensInput>): LensInput => ({
	...base,
	pods,
	totalPods: pods.length,
	...extra,
})

describe("deriveLensVerdict", () => {
	it("says nothing when the service has no k8s workload", () => {
		expect(deriveLensVerdict({ ...base, hasWorkload: false }).kind).toBe("no-workload")
	})

	// An empty set satisfies every universal claim, so "no pod came within 90%"
	// would be vacuously true and read as a clean bill of health.
	it("does not pass a workload with no pods off as healthy", () => {
		const verdict = deriveLensVerdict({ ...base, totalPods: 0 })
		expect(verdict).toEqual({ kind: "no-pods" })
		expect(lensSubhead(verdict)).toContain("no pod reported")
	})

	it("is healthy when no pod is near a limit", () => {
		expect(deriveLensVerdict(withPods([pod(0.3), pod(0.5)]))).toEqual({
			kind: "healthy",
			podCount: 2,
			unbounded: 0,
			sampled: false,
		})
	})

	it("claims cause only when saturation leads the latency spike", () => {
		const verdict = deriveLensVerdict(
			withPods([pod(0.97), pod(0.93), pod(0.4)], {
				// Flat, then a 4x spike from bucket 8.
				latency: latency([100, 100, 100, 100, 100, 100, 100, 100, 400, 420, 410, 400]),
				// Crosses at bucket 4 — four buckets of lead.
				cpuOfLimit: cpu([
					[0, 0.3],
					[2, 0.6],
					[4, 0.95],
					[8, 0.97],
					[11, 0.96],
				]),
			}),
		)
		expect(verdict).toEqual({
			kind: "throttled-and-slow",
			saturated: 2,
			podCount: 3,
			worst: 0.97,
		})
	})

	it("will not claim cause when the spike came first", () => {
		const verdict = deriveLensVerdict(
			withPods([pod(0.97)], {
				// The spike is early and brief; saturation only arrives at bucket 6.
				latency: latency([100, 400, 420, 100, 100, 100, 100, 100]),
				cpuOfLimit: cpu([
					[0, 0.2],
					[6, 0.95],
				]),
			}),
		)
		expect(verdict).toMatchObject({ kind: "throttled", spiked: true })
	})

	it("will not claim cause when saturation only barely leads", () => {
		const verdict = deriveLensVerdict(
			withPods([pod(0.95)], {
				// Spike at bucket 5, saturation at bucket 4 — one bucket is noise.
				latency: latency([100, 100, 100, 100, 100, 400, 400, 400]),
				cpuOfLimit: cpu([
					[0, 0.2],
					[4, 0.92],
					[7, 0.95],
				]),
			}),
		)
		expect(verdict).toMatchObject({ kind: "throttled", spiked: true })
	})

	// The CPU gauges only appear in buckets where a sample landed, so comparing
	// ARRAY POSITIONS compares two different rulers: index 1 of a 3-entry CPU
	// series can be an hour after index 1 of a dense latency series.
	it("measures the lead in time, not in array positions", () => {
		const sparseButLate = deriveLensVerdict(
			withPods([pod(0.95)], {
				latency: latency([100, 100, 400, 420, 100, 100, 100, 100]),
				// Only two entries; the crossing is at bucket 6 — AFTER the spike at
				// bucket 2 — but it sits at array index 1.
				cpuOfLimit: cpu([
					[0, 0.1],
					[6, 0.95],
				]),
			}),
		)
		expect(sparseButLate).toMatchObject({ kind: "throttled", spiked: true })
	})

	it("blames something else when latency spikes with no saturation", () => {
		expect(
			deriveLensVerdict(
				withPods([pod(0.2), pod(0.3)], {
					latency: latency([100, 100, 100, 100, 500, 520, 500, 480]),
					cpuOfLimit: cpu([[0, 0.2]]),
				}),
			),
		).toEqual({ kind: "slow-not-throttled", podCount: 2, unbounded: 0, sampled: false })
	})

	// A service busy for a third of the window has a zero median once the idle
	// buckets are counted, and every real spike then measures as no spike.
	it("takes the latency baseline from served buckets only", () => {
		const verdict = deriveLensVerdict(
			withPods([pod(0.2)], {
				latency: latency([0, 0, 0, 0, 0, 0, 100, 100, 400, 420], { servedFrom: 6 }),
				cpuOfLimit: cpu([[0, 0.1]]),
			}),
		)
		expect(verdict.kind).toBe("slow-not-throttled")
	})

	it("does not read a spike out of a window with no traffic at all", () => {
		const verdict = deriveLensVerdict(
			withPods([pod(0.1)], {
				latency: latency([0, 0, 0, 0]).map((p) => ({ ...p, hasTraffic: false })),
			}),
		)
		expect(verdict.kind).toBe("healthy")
	})

	// A median baseline moves with a rise that fills most of the window, so a
	// sustained elevation reads as no spike. That under-claiming is chosen: the
	// alternative floors fire on ordinary p99 jitter. The copy is worded to
	// match — it never asserts latency was flat.
	it("does not detect a rise that occupies most of the window", () => {
		const verdict = deriveLensVerdict(
			withPods([pod(0.2)], {
				latency: latency([100, 400, 420, 410, 400, 400, 400, 400]),
				cpuOfLimit: cpu([[0, 0.2]]),
			}),
		)
		expect(verdict.kind).toBe("healthy")
	})

	it("treats the saturation threshold as inclusive", () => {
		expect(deriveLensVerdict(withPods([pod(SATURATED)])).kind).toBe("throttled")
	})

	describe("truncated pod lists", () => {
		// The table shows a worst-first PAGE. Saturation claims survive that —
		// the worst pods are on the page by construction — but "they are all
		// unbounded" cannot, because unbounded pods have saturation 0 and sort
		// last, so they are exactly what the page drops.
		it("counts the whole workload, not the page", () => {
			const verdict = deriveLensVerdict({
				...base,
				pods: [pod(0.3), pod(0.2)],
				totalPods: 96,
			})
			expect(verdict).toEqual({ kind: "healthy", podCount: 96, unbounded: 0, sampled: true })
			expect(lensSubhead(verdict)).toContain("96")
		})

		it("will not call a workload unbounded from a partial page", () => {
			const verdict = deriveLensVerdict({
				...base,
				pods: [pod(0, { unbounded: true }), pod(0, { unbounded: true })],
				totalPods: 40,
			})
			expect(verdict.kind).toBe("healthy")
		})

		it("still calls it unbounded when the page IS the workload", () => {
			const verdict = deriveLensVerdict(
				withPods([pod(0, { unbounded: true }), pod(0, { unbounded: true })]),
			)
			expect(verdict).toEqual({ kind: "unbounded", podCount: 2, spiked: false })
			expect(lensSubhead(verdict)).not.toContain("came within")
		})

		it("omits the unbounded caveat it cannot stand behind", () => {
			const verdict = deriveLensVerdict({
				...base,
				pods: [pod(0.3), pod(0, { unbounded: true })],
				totalPods: 60,
			})
			expect(lensSubhead(verdict)).not.toContain("no limits set")
		})
	})
})

describe("lens copy", () => {
	const cases: ReadonlyArray<[string, LensInput]> = [
		["no-workload", { ...base, hasWorkload: false }],
		["no-pods", { ...base, totalPods: 0 }],
		["healthy", withPods([pod(0.2)])],
		["unbounded", withPods([pod(0, { unbounded: true })])],
		[
			"throttled",
			withPods([pod(0.95)], { latency: latency([100, 100, 100]), cpuOfLimit: cpu([[0, 0.95]]) }),
		],
		[
			"throttled-and-slow",
			withPods([pod(0.95)], {
				latency: latency([100, 100, 100, 100, 100, 100, 400, 400]),
				cpuOfLimit: cpu([
					[0, 0.2],
					[1, 0.95],
				]),
			}),
		],
		[
			"slow-not-throttled",
			withPods([pod(0.2)], {
				latency: latency([100, 100, 100, 500, 500, 500]),
				cpuOfLimit: cpu([[0, 0.2]]),
			}),
		],
	]

	it("covers every verdict with a headline and a subhead", () => {
		const kinds = new Set(cases.map(([, input]) => deriveLensVerdict(input).kind))
		expect(kinds.size).toBe(cases.length)
		for (const [, input] of cases) {
			const verdict = deriveLensVerdict(input)
			expect(lensHeadline(verdict, "payments-api")).toMatch(/\S/)
			expect(lensSubhead(verdict)).toMatch(/\S/)
		}
	})

	it("only says “because” for the verdict that earned it", () => {
		for (const [kind, input] of cases) {
			const said = lensHeadline(deriveLensVerdict(input), "payments-api").includes("because")
			expect(said).toBe(kind === "throttled-and-slow")
		}
	})

	// The throttled verdict is reached both when p99 never moved and when it moved
	// without following the saturation. Those are different findings.
	it("never claims p99 held when a spike was measured", () => {
		const spiked = deriveLensVerdict(
			withPods([pod(0.95)], {
				latency: latency([100, 100, 100, 100, 100, 400, 420]),
				cpuOfLimit: cpu([[6, 0.95]]),
			}),
		)
		expect(spiked).toMatchObject({ kind: "throttled", spiked: true })
		expect(lensSubhead(spiked)).not.toContain("p99 held")

		const quiet = deriveLensVerdict(
			withPods([pod(0.95)], {
				latency: latency([100, 100, 100, 100]),
				cpuOfLimit: cpu([[0, 0.95]]),
			}),
		)
		expect(quiet).toMatchObject({ kind: "throttled", spiked: false })
		expect(lensSubhead(quiet)).toContain("no matching rise")
	})
})
