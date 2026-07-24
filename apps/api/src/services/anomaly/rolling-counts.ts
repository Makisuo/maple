export interface CountBucket {
	readonly bucketMs: number
	readonly count: number
}

export interface RollingCountBucket {
	/** End of the rolling window, aligned to `stepMs`. */
	readonly bucketMs: number
	readonly count: number
}

/**
 * Build a zero-filled rolling count series from fixed-width source buckets.
 *
 * A point at T represents [T - windowMs, T), matching a detector that evaluates
 * a trailing window on the same cadence. Source rows use bucket-start times.
 */
export function rollingCountBuckets(
	rows: ReadonlyArray<CountBucket>,
	options: {
		readonly startMs: number
		readonly endMs: number
		readonly stepMs: number
		readonly windowMs: number
	},
): RollingCountBucket[] {
	const { startMs, endMs, stepMs, windowMs } = options
	if (
		!Number.isFinite(startMs) ||
		!Number.isFinite(endMs) ||
		!Number.isFinite(stepMs) ||
		!Number.isFinite(windowMs) ||
		stepMs <= 0 ||
		windowMs <= 0 ||
		startMs > endMs
	) {
		return []
	}

	const countByBucket = new Map<number, number>()
	for (const row of rows) {
		if (!Number.isFinite(row.bucketMs) || !Number.isFinite(row.count)) continue
		const bucketMs = Math.floor(row.bucketMs / stepMs) * stepMs
		countByBucket.set(bucketMs, (countByBucket.get(bucketMs) ?? 0) + row.count)
	}

	const firstEnd = Math.ceil(startMs / stepMs) * stepMs
	const lastEnd = Math.floor(endMs / stepMs) * stepMs
	const points: RollingCountBucket[] = []
	let rollingCount = 0

	for (let sourceMs = firstEnd - windowMs; sourceMs < firstEnd; sourceMs += stepMs) {
		rollingCount += countByBucket.get(sourceMs) ?? 0
	}

	for (let bucketMs = firstEnd; bucketMs <= lastEnd; bucketMs += stepMs) {
		points.push({ bucketMs, count: rollingCount })
		rollingCount -= countByBucket.get(bucketMs - windowMs) ?? 0
		rollingCount += countByBucket.get(bucketMs) ?? 0
	}

	return points
}
