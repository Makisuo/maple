import { defineFn, compileFnCall } from "../define-fn"
import { makeExpr } from "../expr"
import { raw, compile } from "../../sql/sql-fragment"
import type { Expr, Condition } from "../expr"

// ---------------------------------------------------------------------------
// Standard aggregates (defineFn one-liners)
// ---------------------------------------------------------------------------

export const count = defineFn<[], number>("count")
export const avg = defineFn<[Expr<number>], number>("avg")
export const sum = defineFn<[Expr<number>], number>("sum")

// ---------------------------------------------------------------------------
// Condition-taking aggregates
// ---------------------------------------------------------------------------

export const countIf = defineFn<[Condition], number>("countIf")
export const sumIf = defineFn<[Expr<number>, Condition], number>("sumIf")
export const avgIf = defineFn<[Expr<number>, Condition], number>("avgIf")
export const maxIf = defineFn<[Expr<number>, Condition], number>("maxIf")

// ---------------------------------------------------------------------------
// Generic aggregates (compileFnCall for type preservation)
// ---------------------------------------------------------------------------

export function min_<T>(expr: Expr<T>): Expr<NonNullable<T>> {
  return compileFnCall<NonNullable<T>>("min", expr)
}

export function max_<T>(expr: Expr<T>): Expr<NonNullable<T>> {
  return compileFnCall<NonNullable<T>>("max", expr)
}

export function any_<T>(expr: Expr<T>): Expr<T> {
  return compileFnCall<T>("any", expr)
}

export function anyIf<T>(expr: Expr<T>, cond: Condition): Expr<T> {
  return compileFnCall<T>("anyIf", expr, cond)
}

export function uniq<T>(expr: Expr<T>): Expr<number> {
  return compileFnCall<number>("uniq", expr)
}

export function groupUniqArray<T>(expr: Expr<T>): Expr<ReadonlyArray<T>> {
  return compileFnCall<ReadonlyArray<T>>("groupUniqArray", expr)
}

// ---------------------------------------------------------------------------
// Curried / parametric aggregates (handwritten — custom SQL syntax)
// ---------------------------------------------------------------------------

export function quantile(q: number) {
  return (expr: Expr<number>): Expr<number> =>
    makeExpr<number>(raw(`quantile(${q})(${compile(expr.toFragment())})`))
}
