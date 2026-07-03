import { makeExpr } from "../expr"
import { defineCondFn } from "../define-fn"
import { raw, str, compile } from "../../sql/sql-fragment"
import type { Expr } from "../expr"

// ---------------------------------------------------------------------------
// Array constructors (handwritten — bracket syntax, not fn() call)
// ---------------------------------------------------------------------------

export function arrayOf<T>(...exprs: Expr<T>[]): Expr<ReadonlyArray<T>> {
	const args = exprs.map((e) => compile(e.toFragment())).join(", ")
	return makeExpr<ReadonlyArray<T>>(raw(`[${args}]`))
}

// ---------------------------------------------------------------------------
// Array functions (handwritten — polymorphic or special syntax)
// ---------------------------------------------------------------------------

export function arrayStringConcat(
	parts: Expr<string>[] | Expr<ReadonlyArray<string>>,
	sep: string,
): Expr<string> {
	if (Array.isArray(parts)) {
		const arr = parts.map((p: Expr<string>) => compile(p.toFragment())).join(", ")
		return makeExpr<string>(raw(`arrayStringConcat([${arr}], ${compile(str(sep))})`))
	}
	return makeExpr<string>(raw(`arrayStringConcat(${compile(parts.toFragment())}, ${compile(str(sep))})`))
}

export function arrayFilter(fn: string, arr: Expr<any>): Expr<any> {
	return makeExpr<any>(raw(`arrayFilter(${fn}, ${compile(arr.toFragment())})`))
}

/**
 * `has(arr, elem)` — true when `elem` is an element of `arr`. Used with a
 * `bloom_filter` skip index over a concatenated `key=value` items expression so
 * attribute-equality filters prune granules (ClickStack "Items" pattern).
 */
export const has = defineCondFn<[Expr<ReadonlyArray<string>>, Expr<string>]>("has")
