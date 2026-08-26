import { makeExpr } from "../expr"
import { raw, compile } from "../../sql/sql-fragment"
import type { Expr, Condition } from "../expr"
import { Schema } from "effect"
import { compileTypedFnCall, schemaOf, schemaOfAny } from "../define-fn"

// if / multiIf (handwritten — standard fn shape but special arg types)

export function if_<T>(cond: Condition, then_: Expr<T>, else_: Expr<T>): Expr<T> {
	// Both arms produce the same `T`, so either one describes the result.
	return compileTypedFnCall<T>("if", schemaOfAny<T>(then_, else_), cond, then_, else_)
}

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

export function coalesce<T>(...exprs: Expr<T>[]): Expr<T> {
	return compileTypedFnCall<T>("coalesce", schemaOfAny<T>(...exprs), ...exprs)
}

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
