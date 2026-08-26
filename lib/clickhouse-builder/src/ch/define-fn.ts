// Function Factories
//
// Three layers for defining ClickHouse functions:
// 1. defineFn / defineCondFn — one-line declarations for standard fn(args...) pattern
// 2. compileFnCall / compileFnCallCond — thin wrappers for generic/variadic functions
// 3. makeExpr / makeCond (from expr.ts) — escape hatch for custom SQL syntax

import { Schema } from "effect"
import { raw, compile } from "../sql/sql-fragment"
import type { Expr, Condition } from "./expr"
import { makeExpr, makeUntypedExpr, makeCond, toFragment } from "./expr"
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
 *  of their inputs unchanged (`min`, `argMax`, `if`, a window). */
export const schemaOfAny = <T>(...exprs: ReadonlyArray<unknown>): Schema.Codec<T, any> | undefined => {
	for (const expr of exprs) {
		const schema = schemaOf<T>(expr)
		if (schema !== undefined) return schema
	}
	return undefined
}

/**
 * A schema with its `| null` arm removed, or `undefined` when it had none.
 *
 * Read off the AST, like {@link elementSchema}: `Schema.NullOr(x)` is a union
 * of `x` and `Null`, and dropping the `Null` member is the only way back to `x`.
 */
export const withoutNull = <T>(
	schema: Schema.Codec<T | null, any> | undefined,
): Schema.Codec<T, any> | undefined => {
	const ast = schema?.ast
	if (ast?._tag !== "Union") return undefined
	const rest = ast.types.filter((type) => type._tag !== "Null")
	if (rest.length === ast.types.length || rest.length === 0) return undefined
	const members = rest.map((type) => Schema.make(type))
	return (members.length === 1 ? members[0]! : Schema.Union(members)) as Schema.Codec<T, any>
}

// Re-export for consumer convenience
export { makeExpr, makeUntypedExpr, makeCond }

// compileFnCall — low-level helper for handwritten generic/special functions

export function compileFnCall<R>(name: string, ...args: unknown[]): Expr<R> {
	const compiled = args.map((a) => compile(toFragment(a))).join(", ")
	return makeUntypedExpr<R>(raw(`${name}(${compiled})`))
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
//   export const avg = defineFn<[Expr<number>], number>("avg", T.float64)
//   export const min_ = defineFn<[Expr<T>], T>("min", sameAs(0))

/**
 * What a function call returns: a fixed ClickHouse type, or a rule for reading
 * it off the arguments.
 *
 * The second form is the one that used to be hand-rolled per function —
 * `min`/`argMax`/`coalesce` hand back one of their inputs unchanged, `arrayJoin`
 * hands back an element of one — each with its own copy of "look at the
 * argument's schema". {@link sameAs}, {@link firstTyped} and {@link elementOf}
 * are those rules, named.
 */
export type FnResult<Args extends unknown[], R> =
	| CHType<string, R, any>
	| ((...args: Args) => Schema.Codec<R, any> | undefined)

const resultSchema = <Args extends unknown[], R>(
	result: FnResult<Args, R>,
	args: Args,
): Schema.Codec<R, any> | undefined =>
	typeof result === "function" ? result(...args) : (result.schema as Schema.Codec<R, any>)

/**
 * Declare a ClickHouse function.
 *
 * The result type is required. It was optional, and optional is how two thirds
 * of this package's own functions ended up untyped — which costs every query
 * selecting one its whole row schema, since derivation is all-or-nothing.
 * {@link defineUntypedFn} is the explicit way to say a result has no type.
 */
export function defineFn<Args extends unknown[], R>(
	name: string,
	result: FnResult<Args, R>,
): (...args: Args) => Expr<R> {
	return (...args: Args): Expr<R> => compileTypedFnCall<R>(name, resultSchema(result, args), ...args)
}

/**
 * A function whose result has no type to declare.
 *
 * Deliberately separate and deliberately awkward: selecting one costs the query
 * its derived row schema. Reach for it only where the value never becomes a row.
 */
export function defineUntypedFn<Args extends unknown[], R = unknown>(
	name: string,
): (...args: Args) => Expr<R> {
	return (...args: Args): Expr<R> => compileFnCall<R>(name, ...args)
}

// Result rules

/** The result decodes as argument `index` does — `min`, `argMax`, a window. */
export const sameAs =
	<Args extends unknown[], R>(index: number) =>
	(...args: Args): Schema.Codec<R, any> | undefined =>
		schemaOf<R>(args[index])

/** The result decodes as the first argument that knows how it decodes —
 *  `coalesce`, `if`, `least`, where any arm describes the whole. */
export const firstTyped =
	<Args extends unknown[], R>() =>
	(...args: Args): Schema.Codec<R, any> | undefined =>
		schemaOfAny<R>(...args)

/**
 * The result decodes as the first typed argument, minus its `| null` — the rule
 * for `coalesce`/`ifNull`, which return the first argument that is not NULL.
 *
 * ClickHouse types that result non-`Nullable` as soon as one argument is
 * non-`Nullable`, because that argument can always supply a value:
 * `coalesce(nullIf(x, ''), y)` over two `String` columns is a `String`, not a
 * `Nullable(String)`. Reading the first argument's schema alone made every such
 * column derive as `string | null`, which is why the queries that use this
 * shape had to hand-declare a row schema to narrow it back.
 *
 * An argument with no schema says nothing about nullability, so it does not
 * license the narrowing.
 */
export const firstTypedNonNull =
	<Args extends unknown[], R>() =>
	(...args: Args): Schema.Codec<R, any> | undefined => {
		const first = schemaOfAny<R>(...args)
		if (first === undefined) return undefined
		const nonNullArg = args.some((arg) => {
			const schema = schemaOf(arg)
			return schema !== undefined && withoutNull(schema) === undefined
		})
		return nonNullArg ? (withoutNull<R>(first as Schema.Codec<R | null, any>) ?? first) : first
	}

/** The result is one element of argument `index`'s array — `arrayJoin`,
 *  `arrayElement`. */
export const elementOf =
	<Args extends unknown[], R>(index: number) =>
	(...args: Args): Schema.Codec<R, any> | undefined =>
		elementSchema<R>(schemaOf<ReadonlyArray<R>>(args[index]))

/** The result is an array of argument `index` — `groupArray`, `groupUniqArray`. */
export const arrayOfArg =
	<Args extends unknown[], R>(index: number) =>
	(...args: Args): Schema.Codec<ReadonlyArray<R>, any> | undefined => {
		const element = schemaOf<R>(args[index])
		return element ? Schema.Array(element) : undefined
	}

// defineCondFn — same as defineFn but returns Condition
//
// Usage:
//   export const hasToken = defineCondFn<[Expr<string>]>("hasToken")

export function defineCondFn<Args extends unknown[]>(name: string): (...args: Args) => Condition {
	return (...args: Args): Condition => compileFnCallCond(name, ...args)
}
