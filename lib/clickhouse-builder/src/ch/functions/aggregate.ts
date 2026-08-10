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
