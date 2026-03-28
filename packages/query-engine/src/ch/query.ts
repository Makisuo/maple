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

import type { ColumnDefs, CHType } from "./types"
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

export interface CHQueryState {
  readonly tableName: string
  readonly columns: ColumnDefs
  readonly selectFn?: ($: any) => SelectRecord
  readonly whereFn?: ($: any) => Array<Condition | undefined>
  readonly groupByKeys: string[]
  readonly orderBySpecs: Array<[string, "asc" | "desc"]>
  readonly limitValue?: number
  readonly formatValue?: string
}

// ---------------------------------------------------------------------------
// CHQuery interface
// ---------------------------------------------------------------------------

export interface CHQuery<
  Cols extends ColumnDefs = ColumnDefs,
  Output extends Record<string, any> = {},
  Params extends Record<string, any> = {},
> {
  /** @internal — runtime query state */
  readonly _state: CHQueryState
  /** phantom */
  readonly _phantom?: { cols: Cols; output: Output; params: Params }

  select<S extends SelectRecord>(
    fn: ($: ColumnAccessor<Cols>) => S,
  ): CHQuery<Cols, InferOutput<S>, Params>

  where(
    fn: ($: ColumnAccessor<Cols>) => Array<Condition | undefined>,
  ): CHQuery<Cols, Output, Params>

  groupBy(...keys: Array<keyof Output & string>): CHQuery<Cols, Output, Params>

  orderBy(...specs: Array<OrderBySpec<Output>>): CHQuery<Cols, Output, Params>

  limit(n: number): CHQuery<Cols, Output, Params>

  format(fmt: "JSON" | "JSONEachRow"): CHQuery<Cols, Output, Params>

  /** Declare the required compile-time params type. No-op at runtime —
   *  Params is phantom and only constrains what `compile()` accepts. */
  withParams<P extends Record<string, any>>(): CHQuery<Cols, Output, P>
}

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
  Params extends Record<string, any>,
>(state: CHQueryState): CHQuery<Cols, Output, Params> {
  return {
    _state: state,

    select(fn) {
      return makeQuery({ ...state, selectFn: fn })
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

    format(fmt) {
      return makeQuery({ ...state, formatValue: fmt })
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
): CHQuery<Cols, {}, {}> {
  return makeQuery({
    tableName: table.name,
    columns: table.columns,
    groupByKeys: [],
    orderBySpecs: [],
  })
}
