import { defineFn, compileFnCall } from "../define-fn"
import type { Expr } from "../expr"
import * as T from "../types"

// Type conversion (defineFn one-liners)

export const toFloat64OrZero = defineFn<[Expr<string>], number>("toFloat64OrZero", T.float64)
export const toFloat64 = defineFn<[Expr<number>], number>("toFloat64", T.float64)
export const toUInt16OrZero = defineFn<[Expr<string>], number>("toUInt16OrZero", T.uint16)
export const toUInt64 = defineFn<[Expr<number> | Expr<string>], number>("toUInt64", T.uint64)
export const toInt64 = defineFn<[Expr<number>], number>("toInt64", T.uint64)

// Arithmetic (compileFnCall wrappers for mixed arg types)

export function intDiv(a: Expr<number>, b: number | Expr<number>): Expr<number> {
	return compileFnCall<number>("intDiv", a, b)
}

export function round_(expr: Expr<number>, decimals?: number): Expr<number> {
	return decimals != null
		? compileFnCall<number>("round", expr, decimals)
		: compileFnCall<number>("round", expr)
}

// Variadic numeric functions

export function least_(...exprs: Expr<number>[]): Expr<number> {
	return compileFnCall<number>("least", ...exprs)
}

export function greatest_(...exprs: Expr<number>[]): Expr<number> {
	return compileFnCall<number>("greatest", ...exprs)
}

export function cityHash64(...exprs: Expr<any>[]): Expr<number> {
	return compileFnCall<number>("cityHash64", ...exprs)
}
