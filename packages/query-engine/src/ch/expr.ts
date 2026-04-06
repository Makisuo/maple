// ---------------------------------------------------------------------------
// Expression System
//
// Typed expressions that compile to SqlFragment. Every Expr<T> carries a
// phantom TSType so TypeScript can infer output row types from SELECT clauses.
// ---------------------------------------------------------------------------

import type { SqlFragment } from "../sql/sql-fragment"
import {
  raw,
  str,
  compile,
  as_ as sqlAs,
} from "../sql/sql-fragment"
import type { CHType, InferTS } from "./types"

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

export interface Expr<TSType> {
  readonly _brand: "Expr"
  readonly _phantom?: TSType
  toFragment(): SqlFragment

  // Comparison — returns Condition
  eq(other: TSType | Expr<TSType>): Condition
  neq(other: TSType | Expr<TSType>): Condition
  gt(other: TSType | Expr<TSType>): Condition
  gte(other: TSType | Expr<TSType>): Condition
  lt(other: TSType | Expr<TSType>): Condition
  lte(other: TSType | Expr<TSType>): Condition

  // String operations
  like(this: Expr<string>, pattern: string): Condition
  notLike(this: Expr<string>, pattern: string): Condition
  ilike(this: Expr<string>, pattern: string): Condition

  // IN / NOT IN
  in_(...values: TSType[]): Condition
  notIn(...values: TSType[]): Condition

  // Arithmetic — only valid for number expressions
  div(this: Expr<number>, n: number | Expr<number>): Expr<number>
  mul(this: Expr<number>, n: number | Expr<number>): Expr<number>
  add(this: Expr<number>, n: number | Expr<number>): Expr<number>
  sub(this: Expr<number>, n: number | Expr<number>): Expr<number>
}

export interface ColumnRef<
  Name extends string,
  ColType extends CHType<string, any>,
> extends Expr<InferTS<ColType>> {
  readonly columnName: Name
  /** Access a key in a Map column: `$.SpanAttributes.get("http.method")` */
  get(
    this: ColumnRef<Name, CHType<"Map", Record<string, string>>>,
    key: string,
  ): Expr<string>
}

export interface Condition {
  readonly _brand: "Condition"
  toFragment(): SqlFragment
  and(other: Condition): Condition
  or(other: Condition): Condition
}

// ---------------------------------------------------------------------------
// Core helpers (exported for define-fn.ts and consumer extensibility)
// ---------------------------------------------------------------------------

export function toFragment(value: unknown): SqlFragment {
  if (value != null && typeof value === "object" && "_brand" in value) {
    return (value as Expr<unknown>).toFragment()
  }
  if (typeof value === "string") return str(value)
  if (typeof value === "number") return raw(String(value))
  if (typeof value === "boolean") return raw(value ? "1" : "0")
  return raw(String(value))
}

// ---------------------------------------------------------------------------
// Expr implementation
// ---------------------------------------------------------------------------

export function makeExpr<T>(fragment: SqlFragment): Expr<T> {
  const self: Expr<T> = {
    _brand: "Expr" as const,
    toFragment: () => fragment,

    eq: (other) => makeCond(raw(`${compile(fragment)} = ${compile(toFragment(other))}`)),
    neq: (other) => makeCond(raw(`${compile(fragment)} != ${compile(toFragment(other))}`)),
    gt: (other) => makeCond(raw(`${compile(fragment)} > ${compile(toFragment(other))}`)),
    gte: (other) => makeCond(raw(`${compile(fragment)} >= ${compile(toFragment(other))}`)),
    lt: (other) => makeCond(raw(`${compile(fragment)} < ${compile(toFragment(other))}`)),
    lte: (other) => makeCond(raw(`${compile(fragment)} <= ${compile(toFragment(other))}`)),

    like: (pattern: string) => makeCond(raw(`${compile(fragment)} LIKE ${compile(str(pattern))}`)),
    notLike: (pattern: string) => makeCond(raw(`${compile(fragment)} NOT LIKE ${compile(str(pattern))}`)),
    ilike: (pattern: string) => makeCond(raw(`${compile(fragment)} ILIKE ${compile(str(pattern))}`)),

    in_: (...values) => {
      const escaped = values.map((v) => compile(toFragment(v))).join(", ")
      return makeCond(raw(`${compile(fragment)} IN (${escaped})`))
    },
    notIn: (...values) => {
      const escaped = values.map((v) => compile(toFragment(v))).join(", ")
      return makeCond(raw(`${compile(fragment)} NOT IN (${escaped})`))
    },

    div: (n: number | Expr<number>) => makeExpr<number>(raw(`${compile(fragment)} / ${compile(toFragment(n))}`)),
    mul: (n: number | Expr<number>) => makeExpr<number>(raw(`${compile(fragment)} * ${compile(toFragment(n))}`)),
    add: (n: number | Expr<number>) => makeExpr<number>(raw(`${compile(fragment)} + ${compile(toFragment(n))}`)),
    sub: (n: number | Expr<number>) => makeExpr<number>(raw(`${compile(fragment)} - ${compile(toFragment(n))}`)),
  }
  return self
}

// ---------------------------------------------------------------------------
// ColumnRef implementation
// ---------------------------------------------------------------------------

export function makeColumnRef<Name extends string, ColType extends CHType<string, any>>(
  name: Name,
): ColumnRef<Name, ColType> {
  const fragment = raw(name)
  const base = makeExpr<InferTS<ColType>>(fragment)
  return Object.assign(base, {
    columnName: name as Name,
    get(key: string): Expr<string> {
      return makeExpr<string>(raw(`${name}[${compile(str(key))}]`))
    },
  }) as ColumnRef<Name, ColType>
}

// ---------------------------------------------------------------------------
// Condition implementation
// ---------------------------------------------------------------------------

export function makeCond(fragment: SqlFragment): Condition {
  return {
    _brand: "Condition" as const,
    toFragment: () => fragment,
    and: (other) => makeCond(raw(`(${compile(fragment)} AND ${compile(other.toFragment())})`)),
    or: (other) => makeCond(raw(`(${compile(fragment)} OR ${compile(other.toFragment())})`)),
  }
}

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

export function lit(value: string): Expr<string>
export function lit(value: number): Expr<number>
export function lit(value: string | number): Expr<string> | Expr<number> {
  if (typeof value === "string") return makeExpr<string>(str(value))
  return makeExpr<number>(raw(String(value)))
}

// ---------------------------------------------------------------------------
// Subquery expressions
// ---------------------------------------------------------------------------

/**
 * EXISTS (subquery) — for correlated subqueries.
 * The subquery must be compiled separately; this wraps its SQL as a condition.
 */
export function exists(subquerySql: string): Condition {
  return makeCond(raw(`EXISTS (${subquerySql})`))
}

/**
 * expr IN (subquery) — for uncorrelated subqueries.
 * The subquery must be compiled separately; this wraps its SQL as a condition.
 */
export function inSubquery<T>(expr: Expr<T>, subquerySql: string): Condition {
  return makeCond(raw(`${compile(expr.toFragment())} IN (${subquerySql})`))
}

/**
 * Reference an outer query's column in a correlated subquery.
 * Usage: `outerRef("t.TraceId")` or `outerRef("TraceId")`
 */
export function outerRef<T = string>(name: string): Expr<T> {
  return makeExpr<T>(raw(name))
}

export function inList(
  expr: Expr<string>,
  values: readonly string[],
): Condition {
  const escaped = values.map((v) => compile(str(v))).join(", ")
  return makeCond(raw(`${compile(expr.toFragment())} IN (${escaped})`))
}

// ---------------------------------------------------------------------------
// Raw expression (escape hatch)
// ---------------------------------------------------------------------------

export function rawExpr<T = unknown>(sql: string): Expr<T> {
  return makeExpr<T>(raw(sql))
}

export function rawCond(sql: string): Condition {
  return makeCond(raw(sql))
}

/** Create an Expr from a runtime column name (for dynamic column access). */
export function dynamicColumn<T = string>(name: string): Expr<T> {
  return makeExpr<T>(raw(name))
}

// ---------------------------------------------------------------------------
// Aliased expression — used by query compilation
// ---------------------------------------------------------------------------

export function aliased<T>(expr: Expr<T>, alias: string): SqlFragment {
  return sqlAs(expr.toFragment(), alias)
}

// ---------------------------------------------------------------------------
// Conditional helpers (for optional WHERE clauses)
// ---------------------------------------------------------------------------

export function when<T>(
  value: T | undefined | false | null,
  fn: (v: T) => Condition,
): Condition | undefined {
  if (value === undefined || value === null || value === false) return undefined
  return fn(value)
}

export function whenTrue(
  value: boolean | undefined,
  fn: () => Condition,
): Condition | undefined {
  if (!value) return undefined
  return fn()
}

// ---------------------------------------------------------------------------
// Re-export all ClickHouse functions so `import * as CH from "./expr"` works
// ---------------------------------------------------------------------------

export {
  count,
  countIf,
  avg,
  sum,
  min_,
  max_,
  quantile,
  any_,
  anyIf,
  uniq,
  sumIf,
  groupUniqArray,
  toString_,
  positionCaseInsensitive,
  position_,
  left_,
  length_,
  replaceOne,
  extract_,
  concat,
  round_,
  intDiv,
  toFloat64OrZero,
  toUInt16OrZero,
  toUInt64,
  toInt64,
  least_,
  greatest_,
  toStartOfInterval,
  intervalSub,
  if_,
  multiIf,
  coalesce,
  nullIf,
  arrayOf,
  arrayStringConcat,
  arrayFilter,
  mapContains,
  mapGet,
  mapLiteral,
  toJSONString,
} from "./functions"
