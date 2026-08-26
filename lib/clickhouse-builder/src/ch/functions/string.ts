import { compileFnCall, compileTypedFnCall, defineFn } from "../define-fn"
import { makeCond } from "../expr"
import { compile, raw, str } from "../../sql/sql-fragment"
import type { Condition, Expr } from "../expr"
import * as T from "../types"

// Standard string functions (defineFn one-liners)

export const toString_ = defineFn<[Expr<any>], string>("toString", T.string)
export const length_ = defineFn<[Expr<string>], number>("length", T.uint64)
export const lower_ = defineFn<[Expr<string>], string>("lower", T.string)
export const positionCaseInsensitive = defineFn<[Expr<string>, Expr<string>], number>(
	"positionCaseInsensitive",
	T.uint64,
)
export const left_ = defineFn<[Expr<string>, Expr<number>], string>("left", T.string)

// URL functions
//
// ClickHouse parses these without a full URL library: `domain` returns the host
// without scheme, port, or userinfo (and `''` for an unparseable input rather
// than throwing), and `path` returns the pathname only — query string and
// fragment are already excluded, so a path grouped with `path_` carries no
// query-parameter PII. `cutQueryString` is the variant that keeps scheme and
// host, for when the full URL minus its query is wanted.

/** `hex(x)` — the hex rendering of any value's bytes, as a String. The usual
 *  reason to reach for it is making a hash printable. */
export const hex = defineFn<[Expr<any>], string>("hex", T.string)

export const domain_ = defineFn<[Expr<string>], string>("domain", T.string)
export const path_ = defineFn<[Expr<string>], string>("path", T.string)
export const cutQueryString = defineFn<[Expr<string>], string>("cutQueryString", T.string)

// Mixed Expr + literal args (compileFnCall wrappers)

export function position_(haystack: Expr<string>, needle: string): Expr<number> {
	return compileTypedFnCall<number>("position", T.uint64.schema, haystack, needle)
}

export function extract_(expr: Expr<string>, pattern: string): Expr<string> {
	return compileTypedFnCall<string>("extract", T.string.schema, expr, pattern)
}

export function replaceOne(haystack: Expr<string>, pattern: string, replacement: string): Expr<string> {
	return compileTypedFnCall<string>("replaceOne", T.string.schema, haystack, pattern, replacement)
}

/**
 * `match(haystack, pattern)` — RE2 regex test, returning UInt8.
 *
 * The numeric form is what you want when the result is a *value*: aggregating
 * it (`max(match(…))`) or projecting it as a 0/1 flag. Use {@link matchCond}
 * where a predicate is wanted, so the SQL reads as a condition rather than
 * `match(…) = 1`.
 */
export function match_(haystack: Expr<string>, pattern: string): Expr<number> {
	return compileTypedFnCall<number>("match", T.uint8.schema, haystack, pattern)
}

/** `match(haystack, pattern)` as a predicate — see {@link match_}. */
export function matchCond(haystack: Expr<string>, pattern: string): Condition {
	return makeCond(raw(`match(${compile(haystack.toFragment())}, ${compile(str(pattern))})`))
}

// Variadic string functions

export function concat(...exprs: Array<Expr<string> | string>): Expr<string> {
	return compileTypedFnCall<string>("concat", T.string.schema, ...exprs)
}

export function hasToken(haystack: Expr<string>, token: Expr<string> | string): Condition {
	const call = compileFnCall<boolean>("hasToken", haystack, token)
	return makeCond(raw(compile(call.toFragment())))
}

export function hasAllTokens(haystack: Expr<string>, tokens: Expr<string> | string): Condition {
	const call = compileFnCall<boolean>("hasAllTokens", haystack, tokens)
	return makeCond(raw(compile(call.toFragment())))
}
