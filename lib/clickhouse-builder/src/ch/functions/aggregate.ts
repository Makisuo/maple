import { defineFn } from "../define-fn"
import { QueryBuilderError } from "../errors"
import { makeExpr } from "../expr"
import { raw, compile } from "../../sql/sql-fragment"
import type { Expr, Condition } from "../expr"
import { Schema } from "effect"
import * as T from "../types"

import { arrayOfArg, sameAs, schemaOf } from "../define-fn"

/** `groupUniqArrayIf(x, cond)` collects `x`s, so it decodes as an array of `x`. */
const arraySchemaOf = <T>(expr: unknown) => {
	const element = schemaOf<T>(expr)
	return element ? Schema.Array(element) : undefined
}

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

// These hand back one of their arguments unchanged, so they decode as it does.
// `sameAs(0)` is that rule by name — each of them used to carry its own copy.

export const min_ = <T>(expr: Expr<T>): Expr<NonNullable<T>> =>
	defineFn<[Expr<T>], NonNullable<T>>("min", sameAs(0))(expr)

export const max_ = <T>(expr: Expr<T>): Expr<NonNullable<T>> =>
	defineFn<[Expr<T>], NonNullable<T>>("max", sameAs(0))(expr)

export const any_ = <T>(expr: Expr<T>): Expr<T> => defineFn<[Expr<T>], T>("any", sameAs(0))(expr)

export const anyIf = <T>(expr: Expr<T>, cond: Condition): Expr<T> =>
	defineFn<[Expr<T>, Condition], T>("anyIf", sameAs(0))(expr, cond)

export const uniq = <T>(expr: Expr<T>): Expr<number> => defineFn<[Expr<T>], number>("uniq", T.uint64)(expr)

/**
 * `uniqIf(value, condition)` — distinct `value`s among the rows matching
 * `condition`.
 *
 * The conditional counterpart to {@link uniq}, and the one to reach for over
 * `countIf` on a `ReplacingMergeTree`: un-merged duplicate rows for the same
 * key would inflate a `countIf` but not a `uniqIf` on that key.
 */
export const uniqIf = <T>(expr: Expr<T>, cond: Condition): Expr<number> =>
	defineFn<[Expr<T>, Condition], number>("uniqIf", T.uint64)(expr, cond)

export const groupUniqArray = <T>(expr: Expr<T>): Expr<ReadonlyArray<T>> =>
	defineFn<[Expr<T>], ReadonlyArray<T>>("groupUniqArray", arrayOfArg(0))(expr)

/**
 * `groupUniqArrayArray(arrayColumn)` — flatten arrays across rows into one
 * distinct set.
 *
 * The `-Array` combinator form of {@link groupUniqArray}: the argument is
 * already an array per row. This is also the merge function a
 * `SimpleAggregateFunction(groupUniqArrayArray, Array(T))` column is declared
 * with, so reading such a column back uses the same name.
 */
export const groupUniqArrayArray = <T>(expr: Expr<ReadonlyArray<T>>): Expr<ReadonlyArray<T>> =>
	defineFn<[Expr<ReadonlyArray<T>>], ReadonlyArray<T>>("groupUniqArrayArray", sameAs(0))(expr)

/** `argMin(value, orderBy)` — the `value` from the row with the smallest `orderBy`. */
export const argMin = <T>(value: Expr<T>, orderBy: Expr<any>): Expr<T> =>
	defineFn<[Expr<T>, Expr<any>], T>("argMin", sameAs(0))(value, orderBy)

/** `argMax(value, orderBy)` — the `value` from the row with the largest `orderBy`. */
export const argMax = <T>(value: Expr<T>, orderBy: Expr<any>): Expr<T> =>
	defineFn<[Expr<T>, Expr<any>], T>("argMax", sameAs(0))(value, orderBy)

export const argMaxMerge = <T>(expr: Expr<T>): Expr<T> =>
	defineFn<[Expr<T>], T>("argMaxMerge", sameAs(0))(expr)

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
		// Reported, not thrown: the number of conditions is the number of steps a
		// funnel has, and that count comes from data as often as from source.
		if (conditions.length === 0) {
			throw new QueryBuilderError({
				code: "InvalidArguments",
				message: "windowFunnel requires at least one condition",
			})
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
	// An injection guard, so it reports rather than crashes: the pattern is
	// embedded verbatim, and "not user input" is a claim about the caller that
	// the caller is exactly who might get wrong.
	if (pattern.includes("'") || pattern.includes("\\")) {
		throw new QueryBuilderError({
			code: "InvalidArguments",
			message: "sequenceMatch pattern must not contain quotes or backslashes",
		})
	}
	return (timestamp: Expr<any>, ...conditions: ReadonlyArray<Condition>): Expr<number> => {
		if (conditions.length === 0) {
			throw new QueryBuilderError({
				code: "InvalidArguments",
				message: "sequenceMatch requires at least one condition",
			})
		}
		const args = [timestamp.toFragment(), ...conditions.map((c) => c.toFragment())]
			.map(compile)
			.join(", ")
		return makeExpr(raw(`sequenceMatch('${pattern}')(${args})`), T.uint8.schema)
	}
}
