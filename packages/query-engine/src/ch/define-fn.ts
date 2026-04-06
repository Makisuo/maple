// ---------------------------------------------------------------------------
// Function Factories
//
// Three layers for defining ClickHouse functions:
// 1. defineFn / defineCondFn — one-line declarations for standard fn(args...) pattern
// 2. compileFnCall / compileFnCallCond — thin wrappers for generic/variadic functions
// 3. makeExpr / makeCond (from expr.ts) — escape hatch for custom SQL syntax
// ---------------------------------------------------------------------------

import { raw, compile } from "../sql/sql-fragment"
import type { Expr, Condition } from "./expr"
import { makeExpr, makeCond, toFragment } from "./expr"

// Re-export for consumer convenience
export { makeExpr, makeCond, toFragment }

// ---------------------------------------------------------------------------
// compileFnCall — low-level helper for handwritten generic/special functions
// ---------------------------------------------------------------------------

export function compileFnCall<R>(name: string, ...args: unknown[]): Expr<R> {
  const compiled = args.map((a) => compile(toFragment(a))).join(", ")
  return makeExpr<R>(raw(`${name}(${compiled})`))
}

export function compileFnCallCond(name: string, ...args: unknown[]): Condition {
  const compiled = args.map((a) => compile(toFragment(a))).join(", ")
  return makeCond(raw(`${name}(${compiled})`))
}

// ---------------------------------------------------------------------------
// defineFn — declare a standard ClickHouse function in one line
//
// Usage:
//   export const avg = defineFn<[Expr<number>], number>("avg")
//   export const lower = defineFn<[Expr<string>], string>("lower")
// ---------------------------------------------------------------------------

export function defineFn<Args extends unknown[], R>(
  name: string,
): (...args: Args) => Expr<R> {
  return (...args: Args): Expr<R> => compileFnCall<R>(name, ...args)
}

// ---------------------------------------------------------------------------
// defineCondFn — same as defineFn but returns Condition
//
// Usage:
//   export const hasToken = defineCondFn<[Expr<string>]>("hasToken")
// ---------------------------------------------------------------------------

export function defineCondFn<Args extends unknown[]>(
  name: string,
): (...args: Args) => Condition {
  return (...args: Args): Condition => compileFnCallCond(name, ...args)
}
