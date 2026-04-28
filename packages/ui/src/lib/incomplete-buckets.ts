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
 */
export function markIncompleteSegments<T extends Record<string, unknown>>(
	data: T[],
	valueKeys: string[],
	opts?: { now?: number },
): IncompleteSegmentsResult<T> {
	if (data.length === 0) {
		return { data: [], hasIncomplete: false, incompleteKeys: [] }
	}

	const bucketSeconds = inferBucketSeconds(data as unknown as Array<{ bucket: string }>)
	if (bucketSeconds == null) {
		return { data, hasIncomplete: false, incompleteKeys: [] }
	}

	const nowMs = opts?.now ?? Date.now()
	const intervalMs = bucketSeconds * 1000

	// Find the index of the first incomplete bucket
	let firstIncompleteIdx = -1
	for (let i = 0; i < data.length; i++) {
		const bucketMs = parseBucketMs(data[i].bucket)
		if (bucketMs == null) continue
		if (bucketMs + intervalMs > nowMs) {
			firstIncompleteIdx = i
			break
		}
	}

	// No incomplete buckets found
	if (firstIncompleteIdx === -1) {
		return { data, hasIncomplete: false, incompleteKeys: [] }
	}

	const incompleteKeys = valueKeys.map((k) => `${k}_incomplete`)
	const bridgeIdx = firstIncompleteIdx - 1

	const result = data.map((row, i) => {
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
