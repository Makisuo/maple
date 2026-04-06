// ---------------------------------------------------------------------------
// Query Builder
//
// Fluent builder with progressive type accumulation, inspired by Effect's
// HttpApiEndpoint pattern. Each method call refines the type parameters.
//
// Usage:
//   const q = CH.from(Traces)
//     .select($ => ({
//       bucket: CH.toStartOfInterval($.Timestamp, 60),
//       count: CH.count(),
//     }))
//     .where($ => [
//       $.OrgId.eq(CH.param.string("orgId")),
//     ])
//     .groupBy("bucket")
//     .orderBy(["bucket", "asc"])
//     .format("JSON")
// ---------------------------------------------------------------------------

import type { ColumnDefs, CHType, InferTS } from "./types"
import type { Table } from "./table"
import type { Expr, Condition, ColumnRef } from "./expr"
import { makeColumnRef } from "./expr"

// ---------------------------------------------------------------------------
// Type utilities
// ---------------------------------------------------------------------------

export type ColumnAccessor<Cols extends ColumnDefs> = {
  readonly [K in keyof Cols & string]: ColumnRef<K, Cols[K]>
}

type SelectRecord = Record<string, Expr<any>>

export type InferOutput<S extends SelectRecord> = {
  readonly [K in keyof S]: S[K] extends Expr<infer T> ? T : never
}

export type OrderBySpec<Output> = [keyof Output & string, "asc" | "desc"]

// ---------------------------------------------------------------------------
// Query state (runtime storage)
// ---------------------------------------------------------------------------

export interface JoinClause {
  readonly type: "INNER" | "LEFT" | "CROSS"
  /** Table name, or subquery SQL (without parens — compiler wraps subqueries). */
  readonly tableSql: string
  readonly alias: string
  /** ON condition. Omitted for CROSS JOIN. */
  readonly on?: Condition
}

export interface CHQueryState {
  readonly tableName: string
  readonly tableAlias?: string
  readonly columns: ColumnDefs
  readonly selectFn?: ($: any) => SelectRecord
  readonly whereFn?: ($: any) => Array<Condition | undefined>
  readonly groupByKeys: string[]
  readonly orderBySpecs: Array<[string, "asc" | "desc"]>
  readonly limitValue?: number
  readonly offsetValue?: number
  readonly formatValue?: string
  /** When set, the FROM clause uses a subquery instead of a table name. */
  readonly fromSubquerySql?: string
  readonly fromSubqueryAlias?: string
  readonly joins: JoinClause[]
  /** CTE definitions prepended as WITH clauses. */
  readonly ctes: Array<{ name: string; sql: string }>
}

// ---------------------------------------------------------------------------
// CHQuery interface
// ---------------------------------------------------------------------------

export interface CHQuery<
  Cols extends ColumnDefs = ColumnDefs,
  Output extends Record<string, any> = {},
> {
  /** @internal — runtime query state */
  readonly _state: CHQueryState
  /** phantom */
  readonly _phantom?: { cols: Cols; output: Output }

  /** Select specific columns by name. Output keys match column names. */
  select<K extends keyof Cols & string>(
    ...columns: K[]
  ): CHQuery<Cols, { readonly [P in K]: InferTS<Cols[P]> }>

  /** Select computed expressions via callback. */
  select<S extends SelectRecord>(
    fn: ($: ColumnAccessor<Cols>) => S,
  ): CHQuery<Cols, InferOutput<S>>

  where(
    fn: ($: ColumnAccessor<Cols>) => Array<Condition | undefined>,
  ): CHQuery<Cols, Output>

  groupBy(...keys: Array<keyof Output & string>): CHQuery<Cols, Output>

  orderBy(...specs: Array<OrderBySpec<Output>>): CHQuery<Cols, Output>

  limit(n: number): CHQuery<Cols, Output>

  offset(n: number): CHQuery<Cols, Output>

  format(fmt: "JSON" | "JSONEachRow"): CHQuery<Cols, Output>

  /**
   * Add a JOIN clause. The joined table's columns are accessed via the alias
   * in raw expressions (e.g., `CH.dynamicColumn("e.TraceId")`).
   *
   * For CROSS JOIN, pass `on` as `undefined`.
   */
  join(
    tableSql: string,
    alias: string,
    on: Condition | undefined,
    type?: "INNER" | "LEFT" | "CROSS",
  ): CHQuery<Cols, Output>

  /**
   * Add a CTE (WITH clause). The CTE SQL is prepended to the compiled query.
   * The CTE name can then be used as a table name via `from()` or in raw expressions.
   */
  withCTE(name: string, sql: string): CHQuery<Cols, Output>

  /**
   * @deprecated Params are now inferred at the `compile()` call site.
   * This method is a no-op and can be safely removed.
   */
  withParams<_P extends Record<string, any>>(): CHQuery<Cols, Output>
}

// ---------------------------------------------------------------------------
// Type utilities for extracting output types from queries
// ---------------------------------------------------------------------------

/** Extract the Output type from a CHQuery. */
export type InferQueryOutput<Q> = Q extends CHQuery<any, infer O> ? O : never

// ---------------------------------------------------------------------------
// ColumnAccessor factory (Proxy-based)
// ---------------------------------------------------------------------------

export function createColumnAccessor<Cols extends ColumnDefs>(
  _columns: Cols,
): ColumnAccessor<Cols> {
  const cache = new Map<string, ColumnRef<string, CHType<string, any>>>()

  return new Proxy({} as ColumnAccessor<Cols>, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined
      let ref = cache.get(prop)
      if (!ref) {
        ref = makeColumnRef(prop)
        cache.set(prop, ref)
      }
      return ref
    },
  })
}

// ---------------------------------------------------------------------------
// Query builder implementation
// ---------------------------------------------------------------------------

function makeQuery<
  Cols extends ColumnDefs,
  Output extends Record<string, any>,
>(state: CHQueryState): CHQuery<Cols, Output> {
  return {
    _state: state,

    select(...args: any[]): any {
      // String overload: select("Col1", "Col2") → select($ => ({ Col1: $.Col1, Col2: $.Col2 }))
      if (typeof args[0] === "string") {
        const columns = args as string[]
        return makeQuery({
          ...state,
          selectFn: ($: any) => {
            const result: Record<string, any> = {}
            for (const col of columns) result[col] = $[col]
            return result
          },
        })
      }
      // Callback overload: select($ => ({ ... }))
      return makeQuery({ ...state, selectFn: args[0] })
    },

    where(fn) {
      return makeQuery({ ...state, whereFn: fn })
    },

    groupBy(...keys) {
      return makeQuery({ ...state, groupByKeys: keys as string[] })
    },

    orderBy(...specs) {
      return makeQuery({ ...state, orderBySpecs: specs as Array<[string, "asc" | "desc"]> })
    },

    limit(n) {
      return makeQuery({ ...state, limitValue: n })
    },

    offset(n) {
      return makeQuery({ ...state, offsetValue: n })
    },

    format(fmt) {
      return makeQuery({ ...state, formatValue: fmt })
    },

    join(tableSql, alias, on, type = "INNER") {
      return makeQuery({
        ...state,
        joins: [
          ...state.joins,
          { type, tableSql, alias, on },
        ],
      })
    },

    withCTE(name, sql) {
      return makeQuery({
        ...state,
        ctes: [...state.ctes, { name, sql }],
      })
    },

    withParams() {
      // Params is phantom — same runtime state, refined compile-time type
      return makeQuery(state) as any
    },
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function from<Name extends string, Cols extends ColumnDefs>(
  table: Table<Name, Cols>,
  alias?: string,
): CHQuery<Cols, {}> {
  return makeQuery({
    tableName: table.name,
    tableAlias: alias,
    columns: table.columns,
    groupByKeys: [],
    orderBySpecs: [],
    joins: [],
    ctes: [],
  })
}

/**
 * Start a query from a subquery instead of a table.
 *
 * Usage:
 *   const inner = CH.compile(
 *     CH.from(ErrorSpans).select(...).where(...).limit(10),
 *     params,
 *     { skipFormat: true },
 *   )
 *   const outer = CH.fromSubquery(inner.sql, "e").select($ => ({ ... }))
 */
export function fromSubquery(
  sql: string,
  alias: string,
): CHQuery<ColumnDefs, {}> {
  return makeQuery({
    tableName: alias,
    columns: {},
    groupByKeys: [],
    orderBySpecs: [],
    joins: [],
    ctes: [],
    fromSubquerySql: sql,
    fromSubqueryAlias: alias,
  })
}
