import { compileFnCall } from "../define-fn"
import { makeExpr } from "../expr"
import { raw, compile } from "../../sql/sql-fragment"
import type { Expr, Condition } from "../expr"

// ---------------------------------------------------------------------------
// if / multiIf (handwritten — standard fn shape but special arg types)
// ---------------------------------------------------------------------------

export function if_<T>(cond: Condition, then_: Expr<T>, else_: Expr<T>): Expr<T> {
	return compileFnCall<T>("if", cond, then_, else_)
}

export function multiIf<T>(cases: Array<[Condition, Expr<T>]>, else_: Expr<T>): Expr<T> {
	const parts = cases
		.map(([cond, val]) => `${compile(cond.toFragment())}, ${compile(val.toFragment())}`)
		.join(", ")
	return makeExpr<T>(raw(`multiIf(${parts}, ${compile(else_.toFragment())})`))
}

// ---------------------------------------------------------------------------
// Variadic conditional functions
// ---------------------------------------------------------------------------

export function coalesce<T>(...exprs: Expr<T>[]): Expr<T> {
	return compileFnCall<T>("coalesce", ...exprs)
}

export function nullIf<T>(expr: Expr<T>, value: Expr<T> | string): Expr<T> {
	return compileFnCall<T>("nullIf", expr, value)
}
