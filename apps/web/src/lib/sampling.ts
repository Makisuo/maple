/**
 * Summarize sampling-aware throughput for a single (service, env, …) row.
 *
 * The query engine emits `estimatedSpanCount` as a per-row weighted sum
 * (each span contributes its `SampleRate` factor). `tracedSpanCount` is the
 * unweighted row count actually stored in ClickHouse.
 *
 * - `traced`: per-second rate of stored spans.
 * - `estimated`: per-second rate after extrapolating sampled spans.
 * - `hasSampling`: true when the extrapolation factor is meaningfully above 1.
 * - `weight`: estimated/traced ratio (display-only).
 *
 * Treats `estimatedSpanCount = 0` as "no extrapolation data available" (e.g.
 * historical hourly buckets that pre-date the SampleRateSum column) — falls
 * back to `tracedSpanCount`, yielding weight=1 / hasSampling=false. Without
 * this guard the UI would render "x0" weight badges on old time ranges.
 */
export function summarizeSampling(
	estimatedSpanCount: number,
	tracedSpanCount: number,
	durationSeconds: number,
): { traced: number; estimated: number; hasSampling: boolean; weight: number } {
	const effectiveEstimated = estimatedSpanCount > 0 ? estimatedSpanCount : tracedSpanCount
	const weight = tracedSpanCount > 0 ? effectiveEstimated / tracedSpanCount : 1
	const hasSampling = weight > 1.01
	return {
		traced: durationSeconds > 0 ? tracedSpanCount / durationSeconds : 0,
		estimated: durationSeconds > 0 ? effectiveEstimated / durationSeconds : 0,
		hasSampling,
		weight,
	}
}
