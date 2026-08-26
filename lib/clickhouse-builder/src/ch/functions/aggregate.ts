import { defineFn } from "../define-fn"
import { makeExpr } from "../expr"
import { raw, compile } from "../../sql/sql-fragment"
import type { Expr, Condition } from "../expr"
import { Schema } from "effect"
import * as T from "../types"

/** `groupUniqArray(x)` collects `x`s, so it decodes as an array of whatever `x` is. */
const arraySchemaOf = <T>(expr: unknown) => {
	const element = schemaOf<T>(expr)
	return element ? Schema.Array(element) : undefined
}
import { compileTypedFnCall, schemaOf } from "../define-fn"

// Standard aggregates (defineFn one-liners)

export const count = defineFn<[], number>("count", T.uint64)
export const avg = defineFn<[Expr<number>], number>("avg", T.float64)
export const sum = defineFn<[Expr<number>], number>("sum", T.float64)

// Condition-taking aggregates

export const countIf = defineFn<[Condition], number>("countIf", T.uint64)
export const sumIf = defineFn<[Expr<number>, Condition], number>("sumIf", T.float64)
export const avgIf = defineFn<[Expr<number>, Condition], number>("avgIf", T.float64)
export const maxIf = defineFn<[Expr<number>, Condition], number>("maxIf", T.float64)
export const minIf = defineFn<[Expr<number>, Condition], number>("minIf", T.float64)

// Generic aggregates (compileFnCall for type preservation)

export function min_<T>(expr: Expr<T>): Expr<NonNullable<T>> {
	return compileTypedFnCall<NonNullable<T>>("min", schemaOf(expr), expr)
}

export function max_<T>(expr: Expr<T>): Expr<NonNullable<T>> {
	return compileTypedFnCall<NonNullable<T>>("max", schemaOf(expr), expr)
}

export function any_<T>(expr: Expr<T>): Expr<T> {
	return compileTypedFnCall<T>("any", schemaOf<T>(expr), expr)
}

export function anyIf<T>(expr: Expr<T>, cond: Condition): Expr<T> {
	return compileTypedFnCall<T>("anyIf", schemaOf<T>(expr), expr, cond)
}

export function uniq<T>(expr: Expr<T>): Expr<number> {
	return compileTypedFnCall<number>("uniq", T.uint64.schema, expr)
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
	return compileTypedFnCall<number>("uniqIf", T.uint64.schema, expr, cond)
}

export function groupUniqArray<T>(expr: Expr<T>): Expr<ReadonlyArray<T>> {
	return compileTypedFnCall<ReadonlyArray<T>>("groupUniqArray", arraySchemaOf<T>(expr), expr)
}

/**
 * `groupUniqArrayArray(arrayColumn)` — flatten arrays across rows into one
 * distinct set.
 *
 * The `-Array` combinator form of {@link groupUniqArray}: the argument is
 * already an array per row. This is also the merge function a
 * `SimpleAggregateFunction(groupUniqArrayArray, Array(T))` column is declared
 * with, so reading such a column back uses the same name.
 */
export function groupUniqArrayArray<T>(expr: Expr<ReadonlyArray<T>>): Expr<ReadonlyArray<T>> {
	return compileTypedFnCall<ReadonlyArray<T>>("groupUniqArrayArray", schemaOf<ReadonlyArray<T>>(expr), expr)
}

/** `argMin(value, orderBy)` — the `value` from the row with the smallest `orderBy`. */
export function argMin<T>(value: Expr<T>, orderBy: Expr<any>): Expr<T> {
	return compileTypedFnCall<T>("argMin", schemaOf<T>(value), value, orderBy)
}

/** `argMax(value, orderBy)` — the `value` from the row with the largest `orderBy`. */
export function argMax<T>(value: Expr<T>, orderBy: Expr<any>): Expr<T> {
	return compileTypedFnCall<T>("argMax", schemaOf<T>(value), value, orderBy)
}

export function argMaxMerge<T>(expr: Expr<T>): Expr<T> {
	return compileTypedFnCall<T>("argMaxMerge", schemaOf<T>(expr), expr)
}

// Curried / parametric aggregates (handwritten — custom SQL syntax)

export function quantile(q: number) {
	return (expr: Expr<number>): Expr<number> =>
		makeExpr(raw(`quantile(${q})(${compile(expr.toFragment())})`), T.float64.schema)
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
		makeExpr(
			raw(
				`groupUniqArrayIf(${Math.round(maxSize)})(` +
					`${compile(expr.toFragment())}, ${compile(cond.toFragment())})`,
			),
			arraySchemaOf<T>(expr),
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
		return makeExpr(raw(`windowFunnel(${params})(${args})`), T.uint8.schema)
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
		return makeExpr(raw(`sequenceMatch('${pattern}')(${args})`), T.uint8.schema)
	}
}
