// Function Factories
//
// Three layers for defining ClickHouse functions:
// 1. defineFn / defineCondFn — one-line declarations for standard fn(args...) pattern
// 2. compileFnCall / compileFnCallCond — thin wrappers for generic/variadic functions
// 3. makeExpr / makeCond (from expr.ts) — escape hatch for custom SQL syntax

import { Schema } from "effect"
import { raw, compile } from "../sql/sql-fragment"
import type { Expr, Condition } from "./expr"
import { makeExpr, makeCond, toFragment } from "./expr"
import type { CHType } from "./types"

/** The schema an expression decodes with, when it has one. */
export const schemaOf = <T>(expr: unknown): Schema.Codec<T, any> | undefined =>
	(expr as { readonly schema?: Schema.Codec<T, any> } | null | undefined)?.schema

/**
 * The element schema of an array schema, for functions that unnest.
 *
 * Read off the AST rather than reconstructed: `Schema.Array(x)` is the only
 * thing that carries `x`, and losing it would silently drop decoding for every
 * `arrayJoin` result.
 */
export const elementSchema = <T>(
	schema: Schema.Codec<ReadonlyArray<T>, any> | undefined,
): Schema.Codec<T, any> | undefined => {
	const ast = schema?.ast
	if (ast?._tag !== "Arrays") return undefined
	const rest = ast.rest[0]
	return rest === undefined ? undefined : (Schema.make(rest) as Schema.Codec<T, any>)
}

/** The first argument that knows how it decodes — for functions that return one
 *  of their inputs unchanged (`min`, `argMax`, `coalesce`, `if`, a window). */
export const schemaOfAny = <T>(...exprs: ReadonlyArray<unknown>): Schema.Codec<T, any> | undefined => {
	for (const expr of exprs) {
		const schema = schemaOf<T>(expr)
		if (schema !== undefined) return schema
	}
	return undefined
}

// Re-export for consumer convenience
export { makeExpr, makeCond }

// compileFnCall — low-level helper for handwritten generic/special functions

export function compileFnCall<R>(name: string, ...args: unknown[]): Expr<R> {
	const compiled = args.map((a) => compile(toFragment(a))).join(", ")
	return makeExpr<R>(raw(`${name}(${compiled})`))
}

/** `compileFnCall` for a function whose result type is known. */
export function compileTypedFnCall<R>(
	name: string,
	schema: Schema.Codec<R, any> | undefined,
	...args: unknown[]
): Expr<R> {
	const compiled = args.map((a) => compile(toFragment(a))).join(", ")
	return makeExpr<R>(raw(`${name}(${compiled})`), schema)
}

export function compileFnCallCond(name: string, ...args: unknown[]): Condition {
	const compiled = args.map((a) => compile(toFragment(a))).join(", ")
	return makeCond(raw(`${name}(${compiled})`))
}

// defineFn — declare a standard ClickHouse function in one line
//
// Usage:
//   export const avg = defineFn<[Expr<number>], number>("avg")
//   export const lower = defineFn<[Expr<string>], string>("lower")

export function defineFn<Args extends unknown[], R>(
	name: string,
	/** The ClickHouse type the call returns. Supply it and every query using this
	 *  function can derive its row schema; omit it and they cannot. */
	result?: CHType<string, R, any>,
): (...args: Args) => Expr<R> {
	return (...args: Args): Expr<R> => compileTypedFnCall<R>(name, result?.schema, ...args)
}

// defineCondFn — same as defineFn but returns Condition
//
// Usage:
//   export const hasToken = defineCondFn<[Expr<string>]>("hasToken")

export function defineCondFn<Args extends unknown[]>(name: string): (...args: Args) => Condition {
	return (...args: Args): Condition => compileFnCallCond(name, ...args)
}
