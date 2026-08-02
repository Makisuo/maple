import { inferBucketSeconds, parseBucketMs } from "./format"

export interface IncompleteSegmentsResult<T extends Record<string, unknown>> {
	data: T[]
	hasIncomplete: boolean
	incompleteKeys: string[]
}

/**
 * Split time-series data into complete and incomplete segments.
 *
 * For each value key, the output rows contain:
 * - Complete buckets: `key = value`, `key_incomplete = null`
 * - Bridge point (last complete): `key = value`, `key_incomplete = value`
 * - Incomplete buckets: `key = null`, `key_incomplete = value`
 *
 * This allows Recharts to render two overlapping series — one solid (complete)
 * and one dashed (incomplete) — with a seamless connection at the bridge point.
 *
 * Detection is authoritative when the upstream pipeline annotates rows with
 * `partial: true` (it knows the query's bucket size and freshness, so it can flag
 * the in-progress *and* ingestion-lagged trailing buckets that wall-clock alone
 * can't catch). When no row carries that flag, fall back to inferring the bucket
 * size from point spacing and comparing each bucket's end against `now`.
 */
export function markIncompleteSegments<T extends Record<string, unknown>>(
	data: T[],
	valueKeys: string[],
	opts?: { now?: number },
): IncompleteSegmentsResult<T> {
	if (data.length === 0) {
		return { data: [], hasIncomplete: false, incompleteKeys: [] }
	}

	// Prefer an explicit per-row flag set by the data pipeline.
	let firstIncompleteIdx = data.findIndex((row) => row.partial === true)

	if (firstIncompleteIdx === -1) {
		// Fall back to the spacing + wall-clock heuristic.
		const bucketSeconds = inferBucketSeconds(data as unknown as Array<{ bucket: string }>)
		if (bucketSeconds == null) {
			return { data, hasIncomplete: false, incompleteKeys: [] }
		}

		const nowMs = opts?.now ?? Date.now()
		const intervalMs = bucketSeconds * 1000

		for (let i = 0; i < data.length; i++) {
			const bucketMs = parseBucketMs(data[i].bucket)
			if (bucketMs == null) continue
			if (bucketMs + intervalMs > nowMs) {
				firstIncompleteIdx = i
				break
			}
		}
	}

	// No incomplete buckets found
	if (firstIncompleteIdx === -1) {
		return { data, hasIncomplete: false, incompleteKeys: [] }
	}

	// Drop trailing incomplete buckets that carry nothing.
	//
	// The current interval is usually queried before any of its data has landed,
	// so it comes back empty (or zero-filled by the merge step). Plotting it draws
	// a line falling off a cliff to zero at the right edge, which reads as an
	// outage that isn't happening — and `fillNulls: 0` produces the same picture,
	// so there is no presentation setting that fixes it. A bucket we have no
	// reading for is not a reading of zero: end the series at the last bucket that
	// actually reported. Incomplete buckets with real (partial) data are kept and
	// still render dashed.
	const isEmptyRow = (row: T): boolean =>
		valueKeys.every((key) => {
			const value = row[key]
			return value === null || value === undefined || value === 0
		})

	let end = data.length
	while (end > firstIncompleteIdx && end > 1 && isEmptyRow(data[end - 1])) {
		end--
	}

	const trimmed = end === data.length ? data : data.slice(0, end)
	if (end <= firstIncompleteIdx) {
		// Every incomplete bucket was empty — the series simply ends at the last
		// complete one, with no dashed segment to draw.
		return { data: trimmed, hasIncomplete: false, incompleteKeys: [] }
	}

	const incompleteKeys = valueKeys.map((k) => `${k}_incomplete`)
	const bridgeIdx = firstIncompleteIdx - 1

	const result = trimmed.map((row, i) => {
		const next = { ...row } as Record<string, unknown>

		if (i < firstIncompleteIdx) {
			// Complete bucket — null out incomplete keys
			for (const ik of incompleteKeys) {
				next[ik] = null
			}

			// Bridge point: duplicate value into incomplete key so the dashed line connects
			if (i === bridgeIdx) {
				for (let k = 0; k < valueKeys.length; k++) {
					next[incompleteKeys[k]] = row[valueKeys[k]] ?? null
				}
			}
		} else {
			// Incomplete bucket — move values to incomplete keys, null out originals
			for (let k = 0; k < valueKeys.length; k++) {
				next[incompleteKeys[k]] = row[valueKeys[k]] ?? null
				next[valueKeys[k]] = null
			}
		}

		return next as T
	})

	return { data: result, hasIncomplete: true, incompleteKeys }
}
