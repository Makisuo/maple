import type { AlertRulePreviewResponse } from "@maple/domain/http"

/**
 * How the rule would have behaved over the chart's window. Drives the "would
 * have fired N times" callout under the live preview chart on /alerts/create.
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

/**
 * Breach stats from an evaluator-faithful `previewRule` response: counts the
 * simulated `wouldFire` spans — which already account for consecutive-breach
 * requirements and no-data behavior — so the callout says how often the rule
 * *actually* would have fired.
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
