// What the service lens is allowed to claim.
//
// The page's headline is a sentence about cause ("payments-api is slow because
// it is throttled"), and a sentence about cause is the one thing a dashboard
// must not invent. So the claim is derived here, from the data, with an
// explicit ladder: the strong reading is only reached when BOTH signals are
// present and the infra one moves first. Everything below that degrades to a
// weaker, still-true sentence rather than to silence.

import type { PodRow } from "@/components/infra/pod-table"

/** A pod at or above this share of a limit is treated as pinned against it. */
export const SATURATED = 0.9

/** How much p99 must rise over the window's own baseline to count as a spike. */
const SPIKE_RATIO = 1.5

/**
 * How far ahead of the latency spike the saturation must start for the lens to
 * claim precedence. Kubeletstats samples coarsely, so this is deliberately
 * loose — one bucket of lead is noise, three is a sequence.
 *
 * Measured in TIME, not array positions: the two signals arrive on different
 * grids (the span series is filled onto every bucket, the pod gauges only
 * appear where a sample landed), so subtracting indices compares two different
 * rulers and can manufacture a lead that never happened.
 */
const LEAD_BUCKETS = 3

export type LensVerdict =
	/** No k8s workload resolved for this service — the lens has nothing to say. */
	| { kind: "no-workload" }
	/**
	 * A workload, but not one pod reported. Distinct from "healthy" for the same
	 * reason "unbounded" is: an empty set satisfies every universal claim you
	 * could make about it, and none of them would mean anything.
	 */
	| { kind: "no-pods" }
	/**
	 * Every pod runs unbounded, so no limit-based claim is available. Distinct
	 * from "healthy": `saturation` is 0 both for an idle pod and for one with no
	 * limits to be measured against, and calling the second one healthy is a lie
	 * the number happens to permit.
	 */
	| { kind: "unbounded"; podCount: number; spiked: boolean }
	/** Workload known, but no pod with limits is near one. */
	| { kind: "healthy"; podCount: number; unbounded: number; sampled: boolean }
	/** Pods are pinned, and the saturation demonstrably led the latency spike. */
	| { kind: "throttled-and-slow"; saturated: number; podCount: number; worst: number }
	/**
	 * Pods are pinned, but the saturation did not lead a latency spike. `spiked`
	 * separates "p99 never moved" from "p99 moved, just not after this" — they
	 * are different findings and must not share a sentence.
	 */
	| { kind: "throttled"; saturated: number; podCount: number; worst: number; spiked: boolean }
	/** Latency spiked with no saturation to explain it — say so, don't imply k8s. */
	| { kind: "slow-not-throttled"; podCount: number; unbounded: number; sampled: boolean }

/** A bucketed sample. `bucket` is a normalized ISO string; see `unifiedBucketDomain`. */
export interface BucketPoint {
	bucket: string
	value: number
}

export interface LensInput {
	hasWorkload: boolean
	/**
	 * The pods the table is showing — a WORST-FIRST page of the workload, capped
	 * by the list's own limit. See `totalPods`.
	 */
	pods: ReadonlyArray<PodRow>
	/** Every pod in the workload, which `pods` may only be the worst page of. */
	totalPods: number
	/**
	 * p99 per bucket. `hasTraffic` marks buckets the service actually served —
	 * the series is zero-filled, and a zero-filled bucket is not a fast bucket.
	 */
	latency: ReadonlyArray<BucketPoint & { hasTraffic: boolean }>
	/** Worst pod's CPU-of-limit per bucket, sparse where no sample landed. */
	cpuOfLimit: ReadonlyArray<BucketPoint>
	/** Bucket width, so the required lead can be expressed as a duration. */
	bucketSeconds: number
}

/** Epoch ms of the first bucket at or above `threshold`, or null. */
function firstCrossingMs(points: ReadonlyArray<BucketPoint>, threshold: number): number | null {
	for (const point of points) {
		if (!Number.isFinite(point.value) || point.value < threshold) continue
		const ms = new Date(point.bucket).getTime()
		return Number.isFinite(ms) ? ms : null
	}
	return null
}

/**
 * Baseline for the latency spike test: the median of the window, which survives
 * a spike that occupies a minority of it. A mean would be dragged up by the
 * very spike it is supposed to be the baseline for.
 *
 * Deliberately conservative in one direction: a rise that occupies MOST of the
 * window moves the median with it and so reads as no spike. The alternative —
 * a low percentile or the minimum as the floor — fires on ordinary p99 jitter,
 * and a page that cries "slow" at a normally noisy service is worth less than
 * one that occasionally stays quiet. The copy never claims latency was flat,
 * only that no matching rise was found.
 */
function median(values: ReadonlyArray<number>): number {
	const sorted = values.filter((v) => Number.isFinite(v)).toSorted((a, b) => a - b)
	if (sorted.length === 0) return 0
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export function deriveLensVerdict({
	hasWorkload,
	pods,
	totalPods,
	latency,
	cpuOfLimit,
	bucketSeconds,
}: LensInput): LensVerdict {
	if (!hasWorkload) return { kind: "no-workload" }

	// The list is ordered saturation DESC server-side, so a page of it contains
	// the worst pods in the workload. That makes "how many are saturated" sound
	// from a page — but NOT "how many are unbounded": unbounded pods have
	// saturation 0 and sort last, so they are exactly what a page truncates.
	const sampled = pods.length < totalPods
	const podCount = Math.max(totalPods, pods.length)
	if (podCount === 0) return { kind: "no-pods" }
	const saturatedPods = pods.filter((p) => p.saturation >= SATURATED)
	const worst = pods.reduce((max, p) => Math.max(max, p.saturation), 0)
	// Same definition as the pod list's "unbounded" scope: reporting usage, with
	// neither limit set.
	const unbounded = pods.filter(
		(p) => p.cpuLimitPct === 0 && p.memoryLimitPct === 0 && p.cpuUsage > 0,
	).length

	// Only buckets that served traffic can speak to latency. A service busy for
	// a third of the window has a zero median otherwise, and every real spike
	// then measures as "no spike at all".
	const served = latency.filter((point) => point.hasTraffic)
	const baseline = median(served.map((point) => point.value))
	const spikeMs = baseline > 0 ? firstCrossingMs(served, baseline * SPIKE_RATIO) : null
	const saturationMs = firstCrossingMs(cpuOfLimit, SATURATED)

	if (saturatedPods.length === 0) {
		if (podCount > 0 && !sampled && unbounded === podCount) {
			return { kind: "unbounded", podCount, spiked: spikeMs !== null }
		}
		return spikeMs !== null
			? { kind: "slow-not-throttled", podCount, unbounded, sampled }
			: { kind: "healthy", podCount, unbounded, sampled }
	}

	const requiredLeadMs = LEAD_BUCKETS * bucketSeconds * 1000
	const infraLedTheSpike =
		spikeMs !== null && saturationMs !== null && saturationMs + requiredLeadMs <= spikeMs

	if (infraLedTheSpike) {
		return { kind: "throttled-and-slow", saturated: saturatedPods.length, podCount, worst }
	}
	return {
		kind: "throttled",
		saturated: saturatedPods.length,
		podCount,
		worst,
		spiked: spikeMs !== null,
	}
}

/** The headline sentence. Kept beside the verdict so the two can't drift. */
export function lensHeadline(verdict: LensVerdict, serviceName: string): string {
	switch (verdict.kind) {
		case "no-workload":
			return `${serviceName} does not report Kubernetes metadata.`
		case "no-pods":
			return `No pod metrics for ${serviceName}.`
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

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`

/** The supporting line. Every number in it is one the verdict actually carries. */
export function lensSubhead(verdict: LensVerdict): string {
	switch (verdict.kind) {
		case "no-workload":
			return "Its spans carry no k8s.deployment.name, so Maple can't tell which pods run it. Install the Helm chart's k8sattributes processor to link the two."
		case "no-pods":
			return "Its spans name a workload, but no pod reported CPU or memory in this window — so there is nothing here to correlate. Widen the window, or check the kubelet stats receiver."
		case "unbounded":
			return verdict.spiked
				? `p99 rose, and none of its ${verdict.podCount} pods has a CPU or memory limit set — so there is no ceiling for Maple to measure this against. Set limits, or read the raw cores below.`
				: `None of its ${verdict.podCount} pods has a CPU or memory limit set, so saturation can't rank them. The raw usage below is all this page can say.`
		case "healthy": {
			// Sound even from a page: the worst pod is on it by construction.
			const caveat =
				verdict.unbounded > 0 && !verdict.sampled
					? ` ${verdict.unbounded} run with no limits set, so they aren't ranked.`
					: ""
			return `No pod among its ${verdict.podCount} came within ${pct(SATURATED)} of a CPU or memory limit in this window.${caveat}`
		}
		case "throttled-and-slow":
			return `${verdict.saturated} of its ${verdict.podCount} pods hit a limit before p99 rose, peaking at ${pct(verdict.worst)}.`
		case "throttled":
			return verdict.spiked
				? `${verdict.saturated} pods peaked at ${pct(verdict.worst)} of a limit. p99 also rose in this window, but not after the saturation — so the lens won't call one the cause of the other.`
				: // NOT "p99 held": the baseline is the window's own median, so a rise
					// that occupies most of the window is invisible to it. What was
					// actually established is the absence of a matching rise, which is a
					// weaker and true thing to say.
					`${verdict.saturated} pods peaked at or above ${pct(SATURATED)} of a limit — ${pct(verdict.worst)} at worst — with no matching rise in p99 over this window.`
		case "slow-not-throttled":
			return `p99 rose while no pod among its ${verdict.podCount} came near a limit. Look upstream — a dependency, the database, or a change in the work itself.`
	}
}
