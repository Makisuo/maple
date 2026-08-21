import { defineFn, compileFnCall } from "../define-fn"
import { makeExpr } from "../expr"
import { raw, compile } from "../../sql/sql-fragment"
import type { Expr, Condition } from "../expr"

// Standard aggregates (defineFn one-liners)

export const count = defineFn<[], number>("count")
export const avg = defineFn<[Expr<number>], number>("avg")
export const sum = defineFn<[Expr<number>], number>("sum")

// Condition-taking aggregates

export const countIf = defineFn<[Condition], number>("countIf")
export const sumIf = defineFn<[Expr<number>, Condition], number>("sumIf")
export const avgIf = defineFn<[Expr<number>, Condition], number>("avgIf")
export const maxIf = defineFn<[Expr<number>, Condition], number>("maxIf")
export const minIf = defineFn<[Expr<number>, Condition], number>("minIf")

// Generic aggregates (compileFnCall for type preservation)

export function min_<T>(expr: Expr<T>): Expr<NonNullable<T>> {
	return compileFnCall<NonNullable<T>>("min", expr)
}

export function max_<T>(expr: Expr<T>): Expr<NonNullable<T>> {
	return compileFnCall<NonNullable<T>>("max", expr)
}

export function any_<T>(expr: Expr<T>): Expr<T> {
	return compileFnCall<T>("any", expr)
}

export function anyIf<T>(expr: Expr<T>, cond: Condition): Expr<T> {
	return compileFnCall<T>("anyIf", expr, cond)
}

export function uniq<T>(expr: Expr<T>): Expr<number> {
	return compileFnCall<number>("uniq", expr)
}

/**
 * `uniqIf(value, condition)` — distinct `value`s among the rows matching
 * `condition`.
 *
 * The conditional counterpart to {@link uniq}, and the one to reach for over
 * `countIf` on a `ReplacingMergeTree`: un-merged duplicate rows for the same
 * key would inflate a `countIf` but not a `uniqIf` on that key.
 */
export function uniqIf<T>(expr: Expr<T>, cond: Condition): Expr<number> {
	return compileFnCall<number>("uniqIf", expr, cond)
}

export function groupUniqArray<T>(expr: Expr<T>): Expr<ReadonlyArray<T>> {
	return compileFnCall<ReadonlyArray<T>>("groupUniqArray", expr)
}

/** `argMin(value, orderBy)` — the `value` from the row with the smallest `orderBy`. */
export function argMin<T>(value: Expr<T>, orderBy: Expr<any>): Expr<T> {
	return compileFnCall<T>("argMin", value, orderBy)
}

/** `argMax(value, orderBy)` — the `value` from the row with the largest `orderBy`. */
export function argMax<T>(value: Expr<T>, orderBy: Expr<any>): Expr<T> {
	return compileFnCall<T>("argMax", value, orderBy)
}

export function argMaxMerge<T>(expr: Expr<T>): Expr<T> {
	return compileFnCall<T>("argMaxMerge", expr)
}

// Curried / parametric aggregates (handwritten — custom SQL syntax)

export function quantile(q: number) {
	return (expr: Expr<number>): Expr<number> =>
		makeExpr<number>(raw(`quantile(${q})(${compile(expr.toFragment())})`))
}

/**
 * `groupUniqArrayIf(maxSize)(value, condition)` — up to `maxSize` distinct
 * values from the rows matching `condition`.
 *
 * The size is a *parameter* of the aggregate, not an argument, hence the
 * curried shape: `groupUniqArrayIf(3)(x, cond)` → `groupUniqArrayIf(3)(x, cond)`.
 */
export function groupUniqArrayIf(maxSize: number) {
	return <T>(expr: Expr<T>, cond: Condition): Expr<ReadonlyArray<T>> =>
		makeExpr<ReadonlyArray<T>>(
			raw(
				`groupUniqArrayIf(${Math.round(maxSize)})(` +
					`${compile(expr.toFragment())}, ${compile(cond.toFragment())})`,
			),
		)
}

/** The optional `windowFunnel` matching modes — see the ClickHouse docs. */
export type WindowFunnelMode = "strict_order" | "strict_deduplication" | "strict_increase"

/**
 * `windowFunnel(window[, mode])(timestamp, cond1, cond2, …)` — the ClickHouse
 * funnel aggregate: per group, the length of the longest prefix of
 * `cond1..condN` that occurred in that order within `window` of the `cond1`
 * event.
 *
 * `window` is in the unit of `timestamp`, whatever that unit happens to be —
 * seconds for a `Date`/`DateTime` column, but ClickHouse rejects `DateTime64`
 * outright, so a sub-second-precision column has to be projected to an integer
 * first and `window` then follows THAT unit. Projecting with
 * `toUInt64(toUnixTimestamp64Milli(ts))` means passing `windowSeconds * 1000`;
 * passing bare seconds against a millisecond timestamp silently yields a window
 * 1000x too short and a funnel that converts almost nobody past step 1.
 * Ordering within a group happens inside the aggregate; no `ORDER BY` is needed
 * on the input.
 *
 * Curried like {@link quantile}: the window and mode are *parameters* of the
 * aggregate, the timestamp and conditions are its arguments.
 */
export function windowFunnel(window: number, mode?: WindowFunnelMode) {
	const params = mode === undefined ? `${Math.round(window)}` : `${Math.round(window)}, '${mode}'`
	return (timestamp: Expr<any>, ...conditions: ReadonlyArray<Condition>): Expr<number> => {
		if (conditions.length === 0) {
			throw new Error("windowFunnel requires at least one condition")
		}
		const args = [timestamp.toFragment(), ...conditions.map((c) => c.toFragment())]
			.map(compile)
			.join(", ")
		return makeExpr<number>(raw(`windowFunnel(${params})(${args})`))
	}
}

/**
 * `sequenceMatch(pattern)(timestamp, cond1, cond2, …)` — 1 when the events
 * matching `cond1..condN` occur in the order the pattern describes
 * (`'(?1)(?2)'`, `'(?1)(?t<3600)(?2)'`, …), else 0. ClickHouse returns a
 * `UInt8`, exposed as an `Expr<number>` for `sumIf`/`countIf`-style use.
 *
 * The pattern is embedded verbatim — it is ClickHouse's pattern grammar, not
 * user input, so only quote-free literals are accepted.
 */
export function sequenceMatch(pattern: string) {
	if (pattern.includes("'") || pattern.includes("\\")) {
		throw new Error("sequenceMatch pattern must not contain quotes or backslashes")
	}
	return (timestamp: Expr<any>, ...conditions: ReadonlyArray<Condition>): Expr<number> => {
		if (conditions.length === 0) {
			throw new Error("sequenceMatch requires at least one condition")
		}
		const args = [timestamp.toFragment(), ...conditions.map((c) => c.toFragment())]
			.map(compile)
			.join(", ")
		return makeExpr<number>(raw(`sequenceMatch('${pattern}')(${args})`))
	}
}
