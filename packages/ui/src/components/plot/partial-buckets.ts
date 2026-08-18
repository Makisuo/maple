import { inferBucketSeconds, parseBucketMs } from "../../lib/format"

/**
 * A row that can be tested for partiality. `partial` is the authoritative flag
 * when the pipeline sets it; `bucket` drives the fallback heuristic.
 */
export interface PartialCandidateRow {
	bucket: string
	partial?: boolean
}

/**
 * The index of the first in-flight bucket, or `-1` when every bucket is closed.
 *
 * Detection is authoritative when the upstream pipeline annotates rows with
 * `partial: true` — it knows the query's bucket size and freshness, so it can
 * flag the in-progress *and* ingestion-lagged trailing buckets that wall-clock
 * alone cannot catch. When no row carries that flag, fall back to inferring the
 * bucket size from point spacing and comparing each bucket's end against `now`.
 */
export function findFirstPartialIndex(
	rows: ReadonlyArray<PartialCandidateRow>,
	options?: { now?: number },
): number {
	if (rows.length === 0) return -1

	const flagged = rows.findIndex((row) => row.partial === true)
	if (flagged !== -1) return flagged

	const bucketSeconds = inferBucketSeconds(rows)
	if (bucketSeconds == null) return -1

	const nowMs = options?.now ?? Date.now()
	const intervalMs = bucketSeconds * 1000

	for (let index = 0; index < rows.length; index += 1) {
		const bucketMs = parseBucketMs(rows[index].bucket)
		if (bucketMs == null) continue
		if (bucketMs + intervalMs > nowMs) return index
	}
	return -1
}

/**
 * Drops trailing in-flight buckets that carry nothing.
 *
 * The current interval is usually queried before any of its data has landed, so
 * it comes back empty (or zero-filled by the merge step). Plotting it draws a
 * line falling off a cliff to zero at the right edge, which reads as an outage
 * that isn't happening — and `fillNulls: 0` produces the same picture, so there
 * is no presentation setting that fixes it. A bucket we have no reading for is
 * not a reading of zero: end the series at the last bucket that actually
 * reported. Partial buckets with real data are kept and still render dashed.
 */
export function trimEmptyTrailingBuckets<T extends PartialCandidateRow>(
	rows: readonly T[],
	valueKeys: ReadonlyArray<string>,
	firstPartialIndex: number,
): readonly T[] {
	if (firstPartialIndex < 0) return rows

	const isEmptyRow = (row: T): boolean =>
		valueKeys.every((key) => {
			const value = (row as Record<string, unknown>)[key]
			return value === null || value === undefined || value === 0
		})

	let end = rows.length
	while (end > firstPartialIndex && end > 1 && isEmptyRow(rows[end - 1])) {
		end -= 1
	}
	return end === rows.length ? rows : rows.slice(0, end)
}

export interface PartialSplit<T> {
	/** Buckets that are closed — drawn with a solid stroke. */
	solid: readonly T[]
	/** In-flight buckets — drawn dashed. Empty when nothing is in flight. */
	dashed: readonly T[]
	hasPartial: boolean
}

/**
 * Splits rows into a solid run and a dashed tail, sharing one bridge row.
 *
 * This replaces the twin-column `key` / `key_incomplete` rewrite the Recharts
 * charts needed. That scheme existed only because `<Line dataKey>` is a STRING,
 * so a single series could not change its dash mid-line and the second style had
 * to arrive as a second column. TanStack channels are accessors and marks take
 * an array, so the same picture is two marks over two slices of one array —
 * measured as free (36.7ms vs 39.8ms, identical commit counts).
 *
 * The overlap at `first - 1` is the bridge: both marks draw that row, so the
 * dashed segment starts where the solid one ends instead of leaving a gap.
 *
 * `strokeDasharray` on `lineY`/`areaY` is a scalar, NOT a per-datum channel, so
 * two marks is the only way — see `roundCapDasharray` for the geometry the
 * dashed mark needs.
 */
export function splitAtFirstPartial<T extends PartialCandidateRow>(
	rows: readonly T[],
	valueKeys: ReadonlyArray<string>,
	options?: { now?: number },
): PartialSplit<T> {
	const first = findFirstPartialIndex(rows, options)
	if (first === -1) return { solid: rows, dashed: [], hasPartial: false }

	const trimmed = trimEmptyTrailingBuckets(rows, valueKeys, first)
	// Every in-flight bucket was empty: the series ends at the last complete one
	// and there is no dashed segment to draw.
	if (trimmed.length <= first) return { solid: trimmed, dashed: [], hasPartial: false }

	// Nothing complete to bridge from — the whole series is in flight.
	if (first === 0) return { solid: [], dashed: trimmed, hasPartial: true }

	return { solid: trimmed.slice(0, first), dashed: trimmed.slice(first - 1), hasPartial: true }
}
