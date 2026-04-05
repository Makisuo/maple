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
// Internal helpers
// ---------------------------------------------------------------------------

function toFragment(value: unknown): SqlFragment {
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

function makeExpr<T>(fragment: SqlFragment): Expr<T> {
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

function makeCond(fragment: SqlFragment): Condition {
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
// Aggregate functions
// ---------------------------------------------------------------------------

export function count(): Expr<number> {
  return makeExpr<number>(raw("count()"))
}

export function countIf(cond: Condition): Expr<number> {
  return makeExpr<number>(raw(`countIf(${compile(cond.toFragment())})`))
}

export function avg(expr: Expr<number>): Expr<number> {
  return makeExpr<number>(raw(`avg(${compile(expr.toFragment())})`))
}

export function sum(expr: Expr<number>): Expr<number> {
  return makeExpr<number>(raw(`sum(${compile(expr.toFragment())})`))
}

export function min_<T>(expr: Expr<T>): Expr<NonNullable<T>> {
  return makeExpr<NonNullable<T>>(raw(`min(${compile(expr.toFragment())})`))
}

export function max_<T>(expr: Expr<T>): Expr<NonNullable<T>> {
  return makeExpr<NonNullable<T>>(raw(`max(${compile(expr.toFragment())})`))
}

export function quantile(q: number) {
  return (expr: Expr<number>): Expr<number> =>
    makeExpr<number>(raw(`quantile(${q})(${compile(expr.toFragment())})`))
}

export function any_<T>(expr: Expr<T>): Expr<T> {
  return makeExpr<T>(raw(`any(${compile(expr.toFragment())})`))
}

export function anyIf<T>(expr: Expr<T>, cond: Condition): Expr<T> {
  return makeExpr<T>(raw(`anyIf(${compile(expr.toFragment())}, ${compile(cond.toFragment())})`))
}

// ---------------------------------------------------------------------------
// ClickHouse functions
// ---------------------------------------------------------------------------

export function toStartOfInterval(
  col: Expr<string>,
  seconds: number | Expr<number>,
): Expr<string> {
  const secStr = typeof seconds === "number" ? String(Math.round(seconds)) : compile((seconds as Expr<number>).toFragment())
  return makeExpr<string>(raw(`toStartOfInterval(${compile(col.toFragment())}, INTERVAL ${secStr} SECOND)`))
}

export function if_<T>(
  cond: Condition,
  then_: Expr<T>,
  else_: Expr<T>,
): Expr<T> {
  return makeExpr<T>(
    raw(`if(${compile(cond.toFragment())}, ${compile(then_.toFragment())}, ${compile(else_.toFragment())})`),
  )
}

export function coalesce<T>(...exprs: Expr<T>[]): Expr<T> {
  const args = exprs.map((e) => compile(e.toFragment())).join(", ")
  return makeExpr<T>(raw(`coalesce(${args})`))
}

export function nullIf<T>(expr: Expr<T>, value: Expr<T> | string): Expr<T> {
  const valFrag = typeof value === "string" ? str(value) : (value as Expr<T>).toFragment()
  return makeExpr<T>(raw(`nullIf(${compile(expr.toFragment())}, ${compile(valFrag)})`))
}

export function toString_(expr: Expr<any>): Expr<string> {
  return makeExpr<string>(raw(`toString(${compile(expr.toFragment())})`))
}

export function toFloat64OrZero(expr: Expr<string>): Expr<number> {
  return makeExpr<number>(raw(`toFloat64OrZero(${compile(expr.toFragment())})`))
}

export function toUInt16OrZero(expr: Expr<string>): Expr<number> {
  return makeExpr<number>(raw(`toUInt16OrZero(${compile(expr.toFragment())})`))
}

export function positionCaseInsensitive(
  haystack: Expr<string>,
  needle: Expr<string>,
): Expr<number> {
  return makeExpr<number>(
    raw(`positionCaseInsensitive(${compile(haystack.toFragment())}, ${compile(needle.toFragment())})`),
  )
}

export function mapContains(
  mapExpr: Expr<Record<string, string>>,
  key: string,
): Condition {
  return makeCond(raw(`mapContains(${compile(mapExpr.toFragment())}, ${compile(str(key))})`))
}

export function arrayStringConcat(
  parts: Expr<string>[],
  sep: string,
): Expr<string> {
  const arr = parts.map((p) => compile(p.toFragment())).join(", ")
  return makeExpr<string>(raw(`arrayStringConcat([${arr}], ${compile(str(sep))})`))
}

export function arrayFilter(
  fn: string,
  arr: Expr<any>,
): Expr<any> {
  return makeExpr<any>(raw(`arrayFilter(${fn}, ${compile(arr.toFragment())})`))
}

export function extract_(expr: Expr<string>, pattern: string): Expr<string> {
  return makeExpr<string>(raw(`extract(${compile(expr.toFragment())}, ${compile(str(pattern))})`))
}

export function inList(
  expr: Expr<string>,
  values: readonly string[],
): Condition {
  const escaped = values.map((v) => compile(str(v))).join(", ")
  return makeCond(raw(`${compile(expr.toFragment())} IN (${escaped})`))
}

// ---------------------------------------------------------------------------
// Additional aggregate functions
// ---------------------------------------------------------------------------

export function uniq<T>(expr: Expr<T>): Expr<number> {
  return makeExpr<number>(raw(`uniq(${compile(expr.toFragment())})`))
}

export function sumIf(expr: Expr<number>, cond: Condition): Expr<number> {
  return makeExpr<number>(raw(`sumIf(${compile(expr.toFragment())}, ${compile(cond.toFragment())})`))
}

export function groupUniqArray<T>(expr: Expr<T>): Expr<ReadonlyArray<T>> {
  return makeExpr<ReadonlyArray<T>>(raw(`groupUniqArray(${compile(expr.toFragment())})`))
}

// ---------------------------------------------------------------------------
// Additional ClickHouse functions
// ---------------------------------------------------------------------------

export function toJSONString(expr: Expr<any>): Expr<string> {
  return makeExpr<string>(raw(`toJSONString(${compile(expr.toFragment())})`))
}

export function concat(...exprs: Array<Expr<string> | string>): Expr<string> {
  const args = exprs
    .map((e) => (typeof e === "string" ? compile(str(e)) : compile(e.toFragment())))
    .join(", ")
  return makeExpr<string>(raw(`concat(${args})`))
}

export function round_(expr: Expr<number>, decimals?: number): Expr<number> {
  const args = decimals != null
    ? `${compile(expr.toFragment())}, ${decimals}`
    : compile(expr.toFragment())
  return makeExpr<number>(raw(`round(${args})`))
}

export function intDiv(a: Expr<number>, b: number | Expr<number>): Expr<number> {
  const bStr = typeof b === "number" ? String(b) : compile((b as Expr<number>).toFragment())
  return makeExpr<number>(raw(`intDiv(${compile(a.toFragment())}, ${bStr})`))
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
