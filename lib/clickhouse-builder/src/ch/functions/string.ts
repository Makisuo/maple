import { defineFn, compileFnCall } from "../define-fn"
import { makeCond } from "../expr"
import { compile, raw } from "../../sql/sql-fragment"
import type { Condition, Expr } from "../expr"

// ---------------------------------------------------------------------------
// Standard string functions (defineFn one-liners)
// ---------------------------------------------------------------------------

export const toString_ = defineFn<[Expr<any>], string>("toString")
export const length_ = defineFn<[Expr<string>], number>("length")
export const lower_ = defineFn<[Expr<string>], string>("lower")
export const positionCaseInsensitive = defineFn<[Expr<string>, Expr<string>], number>(
	"positionCaseInsensitive",
)
export const left_ = defineFn<[Expr<string>, Expr<number>], string>("left")

// ---------------------------------------------------------------------------
// Mixed Expr + literal args (compileFnCall wrappers)
// ---------------------------------------------------------------------------

export function position_(haystack: Expr<string>, needle: string): Expr<number> {
	return compileFnCall<number>("position", haystack, needle)
}

export function extract_(expr: Expr<string>, pattern: string): Expr<string> {
	return compileFnCall<string>("extract", expr, pattern)
}

export function replaceOne(haystack: Expr<string>, pattern: string, replacement: string): Expr<string> {
	return compileFnCall<string>("replaceOne", haystack, pattern, replacement)
}

// ---------------------------------------------------------------------------
// Variadic string functions
// ---------------------------------------------------------------------------

export function concat(...exprs: Array<Expr<string> | string>): Expr<string> {
	return compileFnCall<string>("concat", ...exprs)
}

export function hasToken(haystack: Expr<string>, token: Expr<string> | string): Condition {
	const call = compileFnCall<boolean>("hasToken", haystack, token)
	return makeCond(raw(compile(call.toFragment())))
}

export function hasAllTokens(haystack: Expr<string>, tokens: Expr<string> | string): Condition {
	const call = compileFnCall<boolean>("hasAllTokens", haystack, tokens)
	return makeCond(raw(compile(call.toFragment())))
}
