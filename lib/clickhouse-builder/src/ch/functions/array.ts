import { makeCond, makeExpr, toFragment } from "../expr"
import { raw, str, compile } from "../../sql/sql-fragment"
import type { Condition, Expr } from "../expr"
import { Schema } from "effect"
import * as T from "../types"
import { defineFn, elementOf, sameAs, schemaOf, schemaOfAny } from "../define-fn"

// Array constructors (handwritten — bracket syntax, not fn() call)

export function arrayOf<T>(...exprs: Expr<T>[]): Expr<ReadonlyArray<T>> {
	const args = exprs.map((e) => compile(e.toFragment())).join(", ")
	const element = schemaOfAny<T>(...exprs)
	return makeExpr(raw(`[${args}]`), element && Schema.Array(element))
}

// Array functions (handwritten — polymorphic or special syntax)

export function arrayStringConcat(
	parts: Expr<string>[] | Expr<ReadonlyArray<string>>,
	sep: string,
): Expr<string> {
	if (Array.isArray(parts)) {
		const arr = parts.map((p: Expr<string>) => compile(p.toFragment())).join(", ")
		return makeExpr(raw(`arrayStringConcat([${arr}], ${compile(str(sep))})`), T.string.schema)
	}
	return makeExpr(
		raw(`arrayStringConcat(${compile(parts.toFragment())}, ${compile(str(sep))})`),
		T.string.schema,
	)
}

export function arrayFilter(fn: string, arr: Expr<any>): Expr<any> {
	return makeExpr(raw(`arrayFilter(${fn}, ${compile(arr.toFragment())})`), schemaOf(arr))
}

/** `arrayJoin` unnests, so the row value is one element of the array. */
export const arrayJoin = <T>(arr: Expr<ReadonlyArray<T>>): Expr<T> =>
	defineFn<[Expr<ReadonlyArray<T>>], T>("arrayJoin", elementOf(0))(arr)

/**
 * Array functions that hand back the array they were given, reordered or
 * filtered — so the result decodes exactly as the input does. `sameAs(0)` says
 * that once instead of once per function.
 */
type ArrayFn<T> = [Expr<ReadonlyArray<T>>]

export const arraySort = <T>(arr: Expr<ReadonlyArray<T>>): Expr<ReadonlyArray<T>> =>
	defineFn<ArrayFn<T>, ReadonlyArray<T>>("arraySort", sameAs(0))(arr)

export const arrayReverseSort = <T>(arr: Expr<ReadonlyArray<T>>): Expr<ReadonlyArray<T>> =>
	defineFn<ArrayFn<T>, ReadonlyArray<T>>("arrayReverseSort", sameAs(0))(arr)

export const arrayDistinct = <T>(arr: Expr<ReadonlyArray<T>>): Expr<ReadonlyArray<T>> =>
	defineFn<ArrayFn<T>, ReadonlyArray<T>>("arrayDistinct", sameAs(0))(arr)

export const arrayPushFront = <T>(arr: Expr<ReadonlyArray<T>>, element: Expr<T>): Expr<ReadonlyArray<T>> =>
	defineFn<[Expr<ReadonlyArray<T>>, Expr<T>], ReadonlyArray<T>>("arrayPushFront", sameAs(0))(arr, element)

/** `arrayElement(arr, n)` — ClickHouse's 1-indexed subscript. The result is one
 *  element, so it decodes as the array's element type. */
export const arrayElement = <T>(arr: Expr<ReadonlyArray<T>>, index: number | Expr<number>): Expr<T> =>
	defineFn<[Expr<ReadonlyArray<T>>, number | Expr<number>], T>("arrayElement", elementOf(0))(arr, index)

export function has<T>(arr: Expr<ReadonlyArray<T>>, value: Expr<T> | T): Condition {
	const valueFragment = toFragment(value)
	return makeCond(raw(`has(${compile(arr.toFragment())}, ${compile(valueFragment)})`))
}
