// Rollup splice boundaries
//
// Several queries reconstruct a time window from two tiers: exact raw rows for
// the partial buckets at each end, plus pre-aggregated rows for every whole
// bucket in between. Correctness rests entirely on the two tiers tiling the
// window — covering it exactly once, with no gap and no overlap.
//
// That boundary was previously written out five separate times (traces ×2,
// logs, services, service-operations) as byte-identical template strings. Every
// copy was a place to get an inequality backwards, and the failure mode is
// silent: a `<=` where a `<` belongs double-counts the trailing bucket, so
// counts inflate rather than error.
//
// The invariants, in one place:
//
//   - The interior is HALF-OPEN: `>= firstFullBucket` and strictly
//     `< endFloor`. The edge predicate is its exact complement.
//   - `firstFullBucket` guards against an aligned start. When the window begins
//     exactly on a boundary, `startFloor` IS the first whole bucket; advancing
//     unconditionally would drop it.
//
// The expressions are SQL strings rather than DSL nodes because they embed
// `__PARAM_*__` placeholders that `compile()` substitutes later.

import * as CH from "@maple-dev/clickhouse-builder/expr"

/**
 * One tier boundary of a splice. `unit` names the bucket size; the rest are
 * the SQL fragments derived from it.
 */
export interface SpliceGrain {
	readonly unit: "HOUR" | "MINUTE"
	/** `parseDateTimeBestEffort(__PARAM_startTime__)` — the window start, unrounded. */
	readonly startDt: string
	readonly endDt: string
	/** The window start rounded DOWN to a bucket boundary. */
	readonly startFloor: string
	readonly endFloor: string
	/** First bucket wholly inside the window (see the aligned-start note above). */
	readonly firstFullBucket: string
}

const makeGrain = (unit: "HOUR" | "MINUTE"): SpliceGrain => {
	const floorFn = unit === "HOUR" ? "toStartOfHour" : "toStartOfMinute"
	// `parseDateTimeBestEffort`, not `toDateTime`: the latter is strictly
	// second-precision and rejects a fractional literal outright —
	// `Cannot parse string '2026-08-15 23:05:00.000' as DateTime`. Callers format
	// window bounds through more than one helper, and a caller that used the
	// millisecond variant took `GET /v2/services` down for three weeks without
	// tripping a test, because the bare `Timestamp >= param` comparisons
	// elsewhere in the same query tolerate the fraction. Best-effort parsing
	// accepts both forms and truncates, so a precision mismatch degrades instead
	// of erroring.
	const startDt = "parseDateTimeBestEffort(__PARAM_startTime__)"
	const endDt = "parseDateTimeBestEffort(__PARAM_endTime__)"
	const startFloor = `${floorFn}(${startDt})`
	const endFloor = `${floorFn}(${endDt})`
	return {
		unit,
		startDt,
		endDt,
		startFloor,
		endFloor,
		firstFullBucket: `if(${startDt} = ${startFloor}, ${startFloor}, ${startFloor} + INTERVAL 1 ${unit})`,
	}
}

export const hourGrain: SpliceGrain = makeGrain("HOUR")
export const minuteGrain: SpliceGrain = makeGrain("MINUTE")

/**
 * The finer tier's predicate: rows outside the whole-bucket interior, i.e. the
 * two partial buckets at the ends of the window.
 *
 * `tsColumn` is the PHYSICAL column on the finer table and varies per table
 * (`Timestamp`, `TimestampTime`, `Minute`) — it is not inferable from the
 * grain. The three-tier service-operations splice reads its minutely tier with
 * the hour grain (`edgeCondition("Minute", hourGrain)`), which is why the
 * column and the grain are separate arguments.
 */
export function edgeCondition(tsColumn: string, grain: SpliceGrain = hourGrain): CH.Condition {
	return CH.rawCond(`(${tsColumn} < ${grain.firstFullBucket} OR ${tsColumn} >= ${grain.endFloor})`)
}

/** The interior bounds as raw SQL, for builders that take a `{ gte, lt }` pair. */
export function interiorBounds(grain: SpliceGrain = hourGrain): {
	readonly gte: string
	readonly lt: string
} {
	return { gte: grain.firstFullBucket, lt: grain.endFloor }
}

/**
 * The aggregate tier's predicate on its bucket column — half-open, so it is the
 * exact complement of `edgeCondition` at the same grain.
 */
export function interiorConditions(
	bucketColumn: CH.Expr<string>,
	grain: SpliceGrain = hourGrain,
): readonly [CH.Condition, CH.Condition] {
	return [
		bucketColumn.gte(CH.rawExpr<string>(grain.firstFullBucket)),
		bucketColumn.lt(CH.rawExpr<string>(grain.endFloor)),
	]
}
