/**
 * Turning per-query timeseries results into the flat, chart-ready rows a caller
 * renders: one row per bucket, one column per series.
 *
 * Pure — no Effect, no port, no warehouse. Lifted out of the web app's
 * `query-builder-timeseries` server function unchanged, because the same merge
 * was needed by the MCP widget inspector and would have been copied a third
 * time. The behaviours preserved verbatim here are load-bearing and each is
 * commented at its site.
 */

import type { QueryRunResult, TimeseriesPoint } from "../formula-results"
import { isEngineUngroupedKey } from "../group-key"

/** A point carries data when its `series` map is non-empty. */
export function hasAnySeriesData(points: ReadonlyArray<TimeseriesPoint>): boolean {
	return points.some((point) => Object.keys(point.series).length > 0)
}

export function countSuccessfulQuerySeries(results: ReadonlyArray<QueryRunResult>): number {
	return results.filter((result) => result.status === "success" && hasAnySeriesData(result.data)).length
}

/**
 * Ids of queries and formulas whose series must not be plotted.
 *
 * `hidden` means "feed the formulas, don't draw me" — a hidden query still runs, because the
 * formula that references it needs its numbers. The query-builder UI has always honored the flag
 * (`widget-builder-utils`) but this data source did not, so a saved widget built on a hidden
 * numerator/denominator plotted its raw operands next to the formula. On a ratio widget that also
 * means raw counts rendered with the ratio's unit — the Cloudflare cache-hit chart drew
 * "416849856400.0%" beside its real 0–1 hit rate.
 */
export function collectHiddenResultIds(input: {
	queries: ReadonlyArray<{ id: string; hidden?: boolean }>
	formulas?: ReadonlyArray<{ id: string; hidden?: boolean }>
}): Set<string> {
	return new Set([
		...input.queries.filter((query) => query.hidden).map((query) => query.id),
		...(input.formulas ?? []).filter((formula) => formula.hidden).map((formula) => formula.id),
	])
}

/** The label each query/formula draws under: its legend if set, else its name. */
export function toDisplayNameById(
	entries: ReadonlyArray<{ id: string; name: string; legend?: string }>,
): Map<string, string> {
	const map = new Map<string, string>()

	for (const entry of entries) {
		const trimmedLegend = (entry.legend ?? "").trim()
		map.set(entry.id, trimmedLegend || entry.name)
	}

	return map
}

/**
 * How one (query, group) pair names its series, and the key it is stable under
 * across the current and previous comparison windows.
 *
 * The `stableGroupKey` is what lets `appendPercentChangeSeries` pair a series
 * with its own shifted counterpart — matching on the *label* would fail the
 * moment the label got a ` (prev)` suffix or a `(2)` disambiguator.
 */
export function toSeriesDescriptor(
	result: QueryRunResult,
	displayName: string,
	rawGroupName: string,
	singleQuery: boolean,
): {
	stableGroupKey: string
	seriesLabel: string
} {
	const normalizedGroupName = rawGroupName.trim() || "unnamed"
	const isAllGroup = isEngineUngroupedKey(normalizedGroupName)
	const isFormulaSelfNamed = result.source === "formula" && normalizedGroupName === displayName

	if (isAllGroup || isFormulaSelfNamed) {
		return {
			stableGroupKey: "__all__",
			seriesLabel: displayName,
		}
	}

	return {
		stableGroupKey: normalizedGroupName,
		seriesLabel: singleQuery ? normalizedGroupName : `${displayName}: ${normalizedGroupName}`,
	}
}

export interface MergedSeries {
	rowsByBucket: Map<string, Record<string, string | number>>
	seriesNameByStableKey: Map<string, string>
	seriesNames: string[]
}

/**
 * Fold N successful query results into bucket-keyed rows.
 *
 * `options.usedSeriesNames` is a MUTABLE set the caller owns, and passing the
 * same one across two calls is how the previous-period window avoids colliding
 * with the current window's names. That makes this call ORDER-DEPENDENT: the
 * current window must be merged before the previous one, or the ` (prev)` series
 * would claim the unsuffixed names first.
 */
export function mergeQueryRunResults(
	results: ReadonlyArray<QueryRunResult>,
	displayNameById: Map<string, string>,
	options?: {
		seriesSuffix?: string
		usedSeriesNames?: Set<string>
	},
): MergedSeries {
	const rowsByBucket = new Map<string, Record<string, string | number>>()
	const usedSeriesNames = options?.usedSeriesNames ?? new Set<string>()
	const seriesNameByStableKey = new Map<string, string>()
	const seriesNames: string[] = []
	const suffix = options?.seriesSuffix ?? ""

	const uniqueName = (base: string): string => {
		if (!usedSeriesNames.has(base)) {
			usedSeriesNames.add(base)
			return base
		}

		let suffix = 2
		while (usedSeriesNames.has(`${base} (${suffix})`)) {
			suffix += 1
		}

		const next = `${base} (${suffix})`
		usedSeriesNames.add(next)
		return next
	}

	// A single plotted query labels its series by group name alone; two or more
	// prefix the query's display name, or "500" from one query and "500" from
	// another would collide into one column.
	const successfulResultCount = results.filter(
		(r) => r.status === "success" && r.data.length > 0 && hasAnySeriesData(r.data),
	).length
	const singleQuery = successfulResultCount <= 1

	for (const result of results) {
		if (result.status !== "success") {
			continue
		}

		if (result.data.length === 0 || !hasAnySeriesData(result.data)) {
			continue
		}

		const preferredName = displayNameById.get(result.queryId) ?? result.queryName

		for (const point of result.data) {
			const row = rowsByBucket.get(point.bucket) ?? { bucket: point.bucket }
			if (Object.keys(point.series).length > 0) {
				for (const [groupName, rawValue] of Object.entries(point.series)) {
					const value = typeof rawValue === "number" ? rawValue : Number(rawValue)
					if (!Number.isFinite(value)) {
						continue
					}

					const descriptor = toSeriesDescriptor(result, preferredName, groupName, singleQuery)
					const stableKey = `${result.queryId}::${descriptor.stableGroupKey}`
					let seriesName = seriesNameByStableKey.get(stableKey)

					if (!seriesName) {
						seriesName = uniqueName(`${descriptor.seriesLabel}${suffix}`)
						seriesNameByStableKey.set(stableKey, seriesName)
						seriesNames.push(seriesName)
					}

					row[seriesName] = value
				}
			}
			rowsByBucket.set(point.bucket, row)
		}
	}

	// Zero-fill: a chart library reading `undefined` for a series in one bucket
	// draws a gap, which reads as missing data rather than as no events.
	for (const row of rowsByBucket.values()) {
		for (const seriesName of seriesNames) {
			if (typeof row[seriesName] !== "number") {
				row[seriesName] = 0
			}
		}
	}

	return {
		rowsByBucket,
		seriesNameByStableKey,
		seriesNames,
	}
}

/** Flatten one or more merged sets (current, previous) into sorted rows. */
export function combineRows(
	mergedSets: ReadonlyArray<{
		rowsByBucket: Map<string, Record<string, string | number>>
		seriesNames: string[]
	}>,
): Array<Record<string, string | number>> {
	const rowsByBucket = new Map<string, Record<string, string | number>>()
	const allSeriesNames = new Set<string>()

	for (const merged of mergedSets) {
		for (const seriesName of merged.seriesNames) {
			allSeriesNames.add(seriesName)
		}

		for (const [bucket, row] of merged.rowsByBucket.entries()) {
			const existing = rowsByBucket.get(bucket) ?? { bucket }
			rowsByBucket.set(bucket, { ...existing, ...row })
		}
	}

	for (const row of rowsByBucket.values()) {
		for (const seriesName of allSeriesNames) {
			if (typeof row[seriesName] !== "number") {
				row[seriesName] = 0
			}
		}
	}

	return Array.from(rowsByBucket.values()).sort((left, right) =>
		String(left.bucket).localeCompare(String(right.bucket)),
	)
}

function shiftBucket(bucket: string, offsetMs: number): string {
	const parsed = new Date(bucket).getTime()
	if (Number.isNaN(parsed)) {
		return bucket
	}

	return new Date(parsed + offsetMs).toISOString()
}

/** Move a previous-period result forward onto the current window's buckets. */
export function shiftResultPoints(
	points: ReadonlyArray<TimeseriesPoint>,
	offsetMs: number,
): TimeseriesPoint[] {
	return points.map((point) => ({
		bucket: shiftBucket(point.bucket, offsetMs),
		series: { ...point.series },
	}))
}

export function shiftRunResults(results: ReadonlyArray<QueryRunResult>, shiftMs: number): QueryRunResult[] {
	return results.map((result) => ({
		...result,
		data: shiftResultPoints(result.data, shiftMs),
	}))
}

/** Append a `(%Δ)` series for every series that has a previous-period twin. */
export function appendPercentChangeSeries(
	rows: ReadonlyArray<Record<string, string | number>>,
	currentSeriesByStableKey: Map<string, string>,
	previousSeriesByStableKey: Map<string, string>,
): void {
	for (const [stableKey, currentSeriesName] of currentSeriesByStableKey.entries()) {
		const previousSeriesName = previousSeriesByStableKey.get(stableKey)
		if (!previousSeriesName) {
			continue
		}

		const deltaSeriesName = `${currentSeriesName} (%Δ)`
		for (const row of rows) {
			const current = row[currentSeriesName]
			const previous = row[previousSeriesName]

			const currentValue = typeof current === "number" && Number.isFinite(current) ? current : 0
			const previousValue = typeof previous === "number" && Number.isFinite(previous) ? previous : 0

			// prev=0 & cur=0 is genuinely "unchanged"; prev=0 & cur>0 has no
			// meaningful percent — omit the point (gap) instead of fabricating 0%.
			if (previousValue === 0) {
				if (currentValue === 0) row[deltaSeriesName] = 0
				continue
			}
			row[deltaSeriesName] = ((currentValue - previousValue) / Math.abs(previousValue)) * 100
		}
	}
}
