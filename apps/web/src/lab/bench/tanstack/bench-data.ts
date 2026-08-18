/**
 * Deterministic synthetic overview data shared by every renderer arm of
 * `/lab/bench/tanstack`. Identical rows in, identical marks out — the only
 * variable between arms is the charting library.
 *
 * Shaped like `ServiceDetailTimeSeriesPoint` as consumed by the three `/`
 * overview charts (see `apps/web/src/routes/index.tsx`).
 */

export interface OverviewBenchRow extends Record<string, unknown> {
	bucket: string
	throughput: number
	errorRate: number
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
}

const BUCKET_COUNT = 145
const BUCKET_MS = 60 * 1000
// Fixed instant, not Date.now(): the bench must produce byte-identical rows on
// every run so the three arms are comparable across sessions.
const END_TIME_MS = Date.UTC(2026, 6, 17, 18, 30)

function makeRows(): OverviewBenchRow[] {
	const rows: OverviewBenchRow[] = []
	for (let index = 0; index < BUCKET_COUNT; index++) {
		const bucket = new Date(END_TIME_MS - (BUCKET_COUNT - 1 - index) * BUCKET_MS).toISOString()
		const phase = (index / (BUCKET_COUNT - 1)) * Math.PI * 6
		const base = 0.55 + 0.35 * Math.sin(phase)
		rows.push({
			bucket,
			throughput: Math.round(4000 * base + 400 * Math.sin(phase * 3.1)),
			errorRate: Math.max(0, 0.02 + 0.018 * Math.sin(phase * 1.7 + 0.9)),
			p50LatencyMs: 40 + 18 * base,
			p95LatencyMs: 180 + 90 * base + 20 * Math.sin(phase * 2.3),
			p99LatencyMs: 420 + 260 * base + 60 * Math.sin(phase * 2.9),
		})
	}
	return rows
}

/**
 * Recharts' `dataKey` reads and TanStack's channel accessors both need a mutable
 * array, so the mutable form is the one that is built.
 */
export const overviewBenchRows: OverviewBenchRow[] = makeRows()
