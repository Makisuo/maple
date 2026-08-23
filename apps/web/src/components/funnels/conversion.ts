// Pure funnel arithmetic — the numbers every surface prints beside a step.

export interface FunnelStepStat {
	/** 1-based step index. */
	readonly step: number
	readonly label: string
	readonly count: number
	/** Share of step 1, 0–1. Step 1 itself is 1 (or 0 when it counted nobody). */
	readonly ofFirst: number
	/** Conversion from the previous step, 0–1; `null` on step 1 or when the previous step counted nobody. */
	readonly ofPrevious: number | null
	/** How many the previous step lost to reach this one; 0 on step 1. */
	readonly dropOff: number
	/** `dropOff` as a share of the previous step, 0–1; `null` on step 1 or when the previous step counted nobody. */
	readonly dropOffRate: number | null
}

/**
 * Join the query's `{ step, count }` rows to their labels and derive the
 * conversion columns. Rows are matched by step number, not position, and a step
 * the query did not return counts zero — `windowFunnel` gives one row per level
 * so that is defensive rather than expected.
 */
export function funnelStepStats(
	labels: ReadonlyArray<string>,
	rows: ReadonlyArray<{ readonly step: number; readonly count: number }>,
): ReadonlyArray<FunnelStepStat> {
	const countByStep = new Map<number, number>()
	for (const row of rows) countByStep.set(row.step, row.count)
	const first = countByStep.get(1) ?? 0
	return labels.map((label, index) => {
		const step = index + 1
		const count = countByStep.get(step) ?? 0
		const previous = index === 0 ? null : (countByStep.get(step - 1) ?? 0)
		const dropOff = previous === null ? 0 : Math.max(0, previous - count)
		return {
			step,
			label,
			count,
			ofFirst: index === 0 ? (first > 0 ? 1 : 0) : first > 0 ? count / first : 0,
			ofPrevious: previous === null || previous <= 0 ? null : count / previous,
			dropOff,
			dropOffRate: previous === null || previous <= 0 ? null : dropOff / previous,
		}
	})
}

/** Overall conversion: last step over first, 0–1; `null` with fewer than two steps or an empty first step. */
export function overallConversion(stats: ReadonlyArray<FunnelStepStat>): number | null {
	if (stats.length < 2) return null
	const first = stats[0]!.count
	if (first <= 0) return null
	return stats[stats.length - 1]!.count / first
}

/** Group breakdown rows into one `{ group, counts[] }` per group, in the order groups first appear. */
export function groupBreakdownRows(
	stepCount: number,
	rows: ReadonlyArray<{ readonly group: string; readonly step: number; readonly count: number }>,
): ReadonlyArray<{ readonly group: string; readonly counts: ReadonlyArray<number> }> {
	const byGroup = new Map<string, number[]>()
	for (const row of rows) {
		let counts = byGroup.get(row.group)
		if (!counts) {
			counts = new Array<number>(stepCount).fill(0)
			byGroup.set(row.group, counts)
		}
		if (row.step >= 1 && row.step <= stepCount) counts[row.step - 1] = row.count
	}
	return [...byGroup.entries()].map(([group, counts]) => ({ group, counts }))
}
