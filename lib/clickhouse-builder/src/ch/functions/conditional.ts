import { makeExpr, toFragment } from "../expr"
import { raw, compile } from "../../sql/sql-fragment"
import type { Expr, Condition } from "../expr"
import { Schema } from "effect"
import {
	compileTypedFnCall,
	defineFn,
	firstTyped,
	firstTypedNonNull,
	schemaOf,
	schemaOfAny,
} from "../define-fn"
import { CHNumber } from "../types"

// if / multiIf (handwritten — standard fn shape but special arg types)

/** Both arms produce the same `T`, so either one describes the result. */
export const if_ = <T>(cond: Condition, then_: Expr<T>, else_: Expr<T>): Expr<T> =>
	defineFn<[Condition, Expr<T>, Expr<T>], T>("if", firstTyped())(cond, then_, else_)

export function multiIf<T>(cases: Array<[Condition, Expr<T>]>, else_: Expr<T>): Expr<T> {
	const parts = cases
		.map(([cond, val]) => `${compile(cond.toFragment())}, ${compile(val.toFragment())}`)
		.join(", ")
	return makeExpr(
		raw(`multiIf(${parts}, ${compile(else_.toFragment())})`),
		schemaOfAny<T>(...cases.map(([, value]) => value), else_),
	)
}

// Variadic conditional functions

/** The first argument that is not NULL — non-nullable as soon as one argument
 *  is, which is what {@link firstTypedNonNull} reads off the arguments. */
export const coalesce = <T>(...exprs: Expr<T>[]): Expr<T> =>
	defineFn<Expr<T>[], T>("coalesce", firstTypedNonNull())(...exprs)

/**
 * `ifNull(expr, fallback)` — `expr` unless it is NULL, else `fallback`. The
 * two-argument coalesce, typed so a non-nullable fallback strips the `| null`
 * that {@link coalesce}'s single `T` cannot.
 */
export const ifNull = <T>(expr: Expr<T | null>, fallback: Expr<T>): Expr<T> =>
	defineFn<[Expr<T | null>, Expr<T>], T>("ifNull", firstTypedNonNull())(expr, fallback)

export function nullIf<T>(expr: Expr<T>, value: Expr<T> | string): Expr<T> {
	// The result is `expr` or NULL, so it decodes as `expr` does — nullably.
	const schema = schemaOf<T>(expr)
	return compileTypedFnCall<T>(
		"nullIf",
		schema && (Schema.NullOr(schema) as Schema.Codec<T, any>),
		expr,
		value,
	)
}

/**
 * `ifNotFinite(expr, fallback)` — `expr` unless it is `nan`/`inf`, else
 * `fallback`.
 *
 * The counterpart to division's nullable decoding (see `div`): it moves the
 * guard into SQL, so the column comes back a real number and decodes as one.
 * `a.div(b)` where `b` can be zero, plus this, is the whole of the unguarded-
 * division problem.
 */
export function ifNotFinite(expr: Expr<number>, fallback: number | Expr<number>): Expr<number> {
	return makeExpr<number>(
		raw(`ifNotFinite(${compile(expr.toFragment())}, ${compile(toFragment(fallback))})`),
		CHNumber as Schema.Codec<number, any>,
	)
}
