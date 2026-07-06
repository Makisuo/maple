import type { AlertComparator, AlertRulePreviewResponse } from "@maple/domain/http"

/**
 * Lightweight back-of-the-envelope estimate of how the rule would have behaved
 * over the chart's window. Drives the "would have fired N times" callout under
 * the live preview chart on /alerts/create. Not a replacement for the real
 * evaluator on the API — it intentionally walks the same `chartData` Recharts
 * sees so the user's eye and the callout agree on a per-bucket basis.
 */
export interface BreachStats {
	bucketCount: number
	breachCount: number
	/** Longest consecutive run of breached buckets. */
	longestRunBuckets: number
	/** Wall-time of the longest run, derived from the bucket timestamps if parseable. */
	longestRunMs: number | null
}

const EMPTY: BreachStats = {
	bucketCount: 0,
	breachCount: 0,
	longestRunBuckets: 0,
	longestRunMs: null,
}

function evaluateBreach(
	value: number,
	comparator: AlertComparator,
	threshold: number,
	thresholdUpper: number | null,
): boolean {
	switch (comparator) {
		case "gt":
			return value > threshold
		case "gte":
			return value >= threshold
		case "lt":
			return value < threshold
		case "lte":
			return value <= threshold
		case "eq":
			return value === threshold
		case "neq":
			return value !== threshold
		case "between":
			return thresholdUpper !== null && value >= threshold && value <= thresholdUpper
		case "not_between":
			return thresholdUpper !== null && (value < threshold || value > thresholdUpper)
	}
}

/** Pick the worst-case (max) numeric value across all non-bucket series in a row. */
function rowPeak(row: Record<string, unknown>): number | null {
	let peak: number | null = null
	for (const key in row) {
		if (key === "bucket") continue
		const raw = row[key]
		const num = typeof raw === "number" ? raw : Number(raw)
		if (!Number.isFinite(num)) continue
		if (peak === null || num > peak) peak = num
	}
	return peak
}

function parseBucket(value: unknown): number | null {
	if (typeof value !== "string") return null
	const parsed = Date.parse(value)
	return Number.isFinite(parsed) ? parsed : null
}

export function computeBreachStats(
	chartData: ReadonlyArray<Record<string, unknown>>,
	threshold: number,
	comparator: AlertComparator,
	thresholdUpper: number | null,
): BreachStats {
	if (chartData.length === 0 || !Number.isFinite(threshold)) return EMPTY
	if (
		(comparator === "between" || comparator === "not_between") &&
		(thresholdUpper === null || !Number.isFinite(thresholdUpper))
	) {
		return { ...EMPTY, bucketCount: chartData.length }
	}

	let breachCount = 0
	let currentRun = 0
	let longestRunBuckets = 0
	let longestRunStartIdx = -1
	let longestRunEndIdx = -1
	let runStartIdx = -1

	for (let i = 0; i < chartData.length; i++) {
		const peak = rowPeak(chartData[i]!)
		const breached = peak !== null && evaluateBreach(peak, comparator, threshold, thresholdUpper)

		if (breached) {
			breachCount++
			if (currentRun === 0) runStartIdx = i
			currentRun++
			if (currentRun > longestRunBuckets) {
				longestRunBuckets = currentRun
				longestRunStartIdx = runStartIdx
				longestRunEndIdx = i
			}
		} else {
			currentRun = 0
		}
	}

	let longestRunMs: number | null = null
	if (longestRunStartIdx >= 0 && longestRunEndIdx >= 0) {
		const startMs = parseBucket(chartData[longestRunStartIdx]!.bucket)
		const endMs = parseBucket(chartData[longestRunEndIdx]!.bucket)
		if (startMs !== null && endMs !== null) {
			// Approximate the run's duration by including the trailing bucket's width.
			// When two adjacent buckets define the bucket size, add one bucket; otherwise
			// fall back to the inclusive timestamp span.
			const nextEndMs =
				longestRunEndIdx + 1 < chartData.length
					? parseBucket(chartData[longestRunEndIdx + 1]!.bucket)
					: null
			const bucketWidthMs =
				nextEndMs !== null
					? nextEndMs - endMs
					: longestRunEndIdx > 0
						? endMs - (parseBucket(chartData[longestRunEndIdx - 1]!.bucket) ?? endMs)
						: 0
			longestRunMs = endMs - startMs + Math.max(bucketWidthMs, 0)
		}
	}

	return {
		bucketCount: chartData.length,
		breachCount,
		longestRunBuckets,
		longestRunMs,
	}
}

/**
 * Breach stats from an evaluator-faithful `previewRule` response. Unlike
 * {@link computeBreachStats} (a per-bucket threshold heuristic over raw chart
 * rows), this counts the simulated `wouldFire` spans — which already account
 * for consecutive-breach requirements and no-data behavior — so the callout
 * says how often the rule *actually* would have fired.
 */
export function breachStatsFromPreview(preview: AlertRulePreviewResponse | null): BreachStats {
	if (preview == null) return EMPTY
	const bucketCount = preview.series.reduce((max, s) => Math.max(max, s.points.length), 0)
	if (preview.wouldFire.length === 0) return { ...EMPTY, bucketCount }
	const windowMs = preview.windowMinutes * 60_000
	let longestRunMs: number | null = null
	for (const span of preview.wouldFire) {
		const start = Date.parse(span.start)
		const end = Date.parse(span.end)
		if (!Number.isFinite(start) || !Number.isFinite(end)) continue
		const duration = end - start
		if (longestRunMs === null || duration > longestRunMs) longestRunMs = duration
	}
	return {
		bucketCount,
		breachCount: preview.wouldFire.length,
		longestRunBuckets:
			longestRunMs != null && windowMs > 0 ? Math.max(1, Math.round(longestRunMs / windowMs)) : 1,
		longestRunMs,
	}
}

/** Format a millisecond duration as a compact human string (e.g. `12m`, `1h 5m`). */
export function formatBreachDuration(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms) || ms <= 0) return "—"
	const totalMins = Math.round(ms / 60_000)
	if (totalMins < 1) {
		const secs = Math.max(1, Math.round(ms / 1000))
		return `${secs}s`
	}
	if (totalMins < 60) return `${totalMins}m`
	const hours = Math.floor(totalMins / 60)
	const mins = totalMins % 60
	return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}
