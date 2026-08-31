// What the service lens is allowed to claim.
//
// The page's headline is a sentence about cause ("payments-api is slow because
// it is throttled"), and a sentence about cause is the one thing a dashboard
// must not invent. So the claim is derived here, from the data, with an
// explicit ladder: the strong reading is only reached when BOTH signals are
// present and the infra one moves first. Everything below that degrades to a
// weaker, still-true sentence rather than to silence.

import type { PodRow } from "@/components/infra/pod-table"
import type { ServiceDetailTimeSeriesPoint } from "@/api/warehouse/services"

/** A pod at or above this share of a limit is treated as pinned against it. */
export const SATURATED = 0.9

/** How much p99 must rise over the window's own baseline to count as a spike. */
const SPIKE_RATIO = 1.5

/**
 * How far ahead of the latency spike the saturation must start for the lens to
 * claim precedence. Kubeletstats samples coarsely, so this is deliberately
 * loose — one bucket of lead is noise, three is a sequence.
 */
const LEAD_BUCKETS = 3

export type LensVerdict =
	/** No k8s workload resolved for this service — the lens has nothing to say. */
	| { kind: "no-workload" }
	/**
	 * Every pod runs unbounded, so no limit-based claim is available. Distinct
	 * from "healthy": `saturation` is 0 both for an idle pod and for one with no
	 * limits to be measured against, and calling the second one healthy is a lie
	 * the number happens to permit.
	 */
	| { kind: "unbounded"; podCount: number; spiked: boolean }
	/** Workload known, but no pod with limits is near one. */
	| { kind: "healthy"; podCount: number; unbounded: number }
	/** Pods are pinned, and the saturation demonstrably led the latency spike. */
	| { kind: "throttled-and-slow"; saturated: number; podCount: number; worst: number }
	/** Pods are pinned, but latency did not spike (or we can't line them up). */
	| { kind: "throttled"; saturated: number; podCount: number; worst: number }
	/** Latency spiked with no saturation to explain it — say so, don't imply k8s. */
	| { kind: "slow-not-throttled"; podCount: number; unbounded: number }

export interface LensInput {
	hasWorkload: boolean
	pods: ReadonlyArray<PodRow>
	points: ReadonlyArray<ServiceDetailTimeSeriesPoint>
	/** CPU-of-limit series for the workload, long-form as the charts carry it. */
	cpuOfLimit: ReadonlyArray<{ bucket: string; value: number }>
}

/**
 * The first bucket index at or above `threshold`, or -1. Used on both series so
 * "which moved first" is one comparison of two indices into the same bucket
 * grid — the charts already share that grid, which is the whole point of
 * stacking them.
 */
function firstIndexAtOrAbove(values: ReadonlyArray<number>, threshold: number): number {
	return values.findIndex((v) => Number.isFinite(v) && v >= threshold)
}

/**
 * Baseline for the latency spike test: the median of the window, which survives
 * a spike that occupies a minority of it. A mean would be dragged up by the
 * very spike it is supposed to be the baseline for.
 */
function median(values: ReadonlyArray<number>): number {
	const sorted = values.filter((v) => Number.isFinite(v)).toSorted((a, b) => a - b)
	if (sorted.length === 0) return 0
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export function deriveLensVerdict({ hasWorkload, pods, points, cpuOfLimit }: LensInput): LensVerdict {
	if (!hasWorkload) return { kind: "no-workload" }

	const podCount = pods.length
	const saturatedPods = pods.filter((p) => p.saturation >= SATURATED)
	const worst = pods.reduce((max, p) => Math.max(max, p.saturation), 0)
	// Same definition as the pod list's "unbounded" scope: reporting usage, with
	// neither limit set.
	const unbounded = pods.filter(
		(p) => p.cpuLimitPct === 0 && p.memoryLimitPct === 0 && p.cpuUsage > 0,
	).length

	const latencies = points.map((p) => p.p99LatencyMs)
	const baseline = median(latencies)
	// A window with no traffic has a zero baseline; every value would then read
	// as an infinite spike.
	const spikeIndex = baseline > 0 ? firstIndexAtOrAbove(latencies, baseline * SPIKE_RATIO) : -1
	const saturationIndex = firstIndexAtOrAbove(
		cpuOfLimit.map((r) => r.value),
		SATURATED,
	)

	if (saturatedPods.length === 0) {
		if (podCount > 0 && unbounded === podCount) {
			return { kind: "unbounded", podCount, spiked: spikeIndex >= 0 }
		}
		return spikeIndex >= 0
			? { kind: "slow-not-throttled", podCount, unbounded }
			: { kind: "healthy", podCount, unbounded }
	}

	const infraLedTheSpike =
		spikeIndex >= 0 && saturationIndex >= 0 && saturationIndex + LEAD_BUCKETS <= spikeIndex

	return {
		kind: infraLedTheSpike ? "throttled-and-slow" : "throttled",
		saturated: saturatedPods.length,
		podCount,
		worst,
	}
}

/** The headline sentence. Kept beside the verdict so the two can't drift. */
export function lensHeadline(verdict: LensVerdict, serviceName: string): string {
	switch (verdict.kind) {
		case "no-workload":
			return `${serviceName} does not report Kubernetes metadata.`
		case "unbounded":
			return `${serviceName} runs without limits.`
		case "healthy":
			return `${serviceName} is running clear of its limits.`
		case "throttled-and-slow":
			return `${serviceName} is slow because it is throttled.`
		case "throttled":
			return `${serviceName} is pinned against its limits.`
		case "slow-not-throttled":
			return `${serviceName} is slow, and Kubernetes is not why.`
	}
}

/** The supporting line. Every number in it is one the verdict actually carries. */
export function lensSubhead(verdict: LensVerdict): string {
	switch (verdict.kind) {
		case "no-workload":
			return "Its spans carry no k8s.deployment.name, so Maple can't tell which pods run it. Install the Helm chart's k8sattributes processor to link the two."
		case "unbounded":
			return verdict.spiked
				? `p99 rose, and none of its ${verdict.podCount} pods has a CPU or memory limit set — so there is no ceiling for Maple to measure this against. Set limits, or read the raw cores below.`
				: `None of its ${verdict.podCount} pods has a CPU or memory limit set, so saturation can't rank them. The raw usage below is all this page can say.`
		case "healthy": {
			const bounded = verdict.podCount - verdict.unbounded
			const caveat =
				verdict.unbounded > 0
					? ` The other ${verdict.unbounded} run with no limits set, so they aren't ranked.`
					: ""
			return `All ${bounded} pods with limits stayed below ${Math.round(SATURATED * 100)}% of them in this window.${caveat}`
		}
		case "throttled-and-slow":
			return `${verdict.saturated} of its ${verdict.podCount} pods hit a limit before p99 rose, peaking at ${Math.round(verdict.worst * 100)}%.`
		case "throttled":
			return `${verdict.saturated} of its ${verdict.podCount} pods peaked at or above ${Math.round(SATURATED * 100)}% of a limit — ${Math.round(verdict.worst * 100)}% at worst — but p99 held.`
		case "slow-not-throttled": {
			const bounded = verdict.podCount - verdict.unbounded
			const caveat = verdict.unbounded > 0 ? ` (${verdict.unbounded} of them have no limits set)` : ""
			return `p99 rose while all ${bounded} pods with limits stayed clear of them${caveat}. Look upstream — a dependency, the database, or a change in the work itself.`
		}
	}
}
