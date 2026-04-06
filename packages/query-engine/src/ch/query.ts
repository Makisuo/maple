// ---------------------------------------------------------------------------
// Query Builder
//
// Fluent builder with progressive type accumulation, inspired by Kysely's
// type-safe joins. Each method call refines the type parameters.
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
//
// Type-safe joins:
//   CH.from(Traces)
//     .innerJoin(ErrorSpans, "e", (main, e) => main.TraceId.eq(e.TraceId))
//     .select($ => ({
//       traceId: $.TraceId,
//       errorType: $.e.ErrorType,
//     }))
// ---------------------------------------------------------------------------

import type { ColumnDefs, CHType, InferTS, OutputToColumnDefs, NullableColumnDefs } from "./types"
import type { Table } from "./table"
import type { Expr, Condition, ColumnRef } from "./expr"
import { makeColumnRef } from "./expr"

// ---------------------------------------------------------------------------
// Type utilities
// ---------------------------------------------------------------------------

export type ColumnAccessor<Cols extends ColumnDefs> = {
  readonly [K in keyof Cols & string]: ColumnRef<K, Cols[K]>
}

/** Combined accessor: main table columns + nested alias accessors for joins. */
export type JoinedColumnAccessor<
  Cols extends ColumnDefs,
  Joins extends Record<string, ColumnDefs>,
> = ColumnAccessor<Cols> & {
  readonly [A in keyof Joins & string]: ColumnAccessor<Joins[A]>
}

type SelectRecord = Record<string, Expr<any>>

export type InferOutput<S extends SelectRecord> = {
  readonly [K in keyof S]: S[K] extends Expr<infer T> ? T : never
}

export type OrderBySpec<Output> = [keyof Output & string, "asc" | "desc"]

/** Callback for ON conditions — receives main and joined column accessors. */
export type JoinOnCallback<
  MainCols extends ColumnDefs,
  JoinedCols extends ColumnDefs,
> = (main: ColumnAccessor<MainCols>, joined: ColumnAccessor<JoinedCols>) => Condition

// ---------------------------------------------------------------------------
// Query state (runtime storage)
// ---------------------------------------------------------------------------

export interface TypedJoinClause {
  readonly type: "INNER" | "LEFT" | "CROSS"
  /** Table name for direct table joins. */
  readonly tableName?: string
  /** Inner query for subquery joins (compiled lazily at compileCH time). */
  readonly innerQuery?: CHQuery<any, any, any>
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
  /** Typed FROM subquery. Compiled lazily at compileCH time. */
  readonly fromQuery?: CHQuery<any, any, any>
  readonly fromQueryAlias?: string
  /** Typed joins (compiled lazily at compileCH time). */
  readonly typedJoins: TypedJoinClause[]
  /** CTE definitions prepended as WITH clauses. */
  readonly ctes: Array<{ name: string; sql: string }>
}

// ---------------------------------------------------------------------------
// CHQuery interface
// ---------------------------------------------------------------------------

export interface CHQuery<
  Cols extends ColumnDefs = ColumnDefs,
  Output extends Record<string, any> = {},
  Joins extends Record<string, ColumnDefs> = {},
> {
  /** @internal — runtime query state */
  readonly _state: CHQueryState
  /** phantom */
  readonly _phantom?: { cols: Cols; output: Output; joins: Joins }

  /** Select specific columns by name. Output keys match column names. */
  select<K extends keyof Cols & string>(
    ...columns: K[]
  ): CHQuery<Cols, { readonly [P in K]: InferTS<Cols[P]> }, Joins>

  /** Select computed expressions via callback. */
  select<S extends SelectRecord>(
    fn: ($: JoinedColumnAccessor<Cols, Joins>) => S,
  ): CHQuery<Cols, InferOutput<S>, Joins>

  where(
    fn: ($: JoinedColumnAccessor<Cols, Joins>) => Array<Condition | undefined>,
  ): CHQuery<Cols, Output, Joins>

  groupBy(...keys: Array<keyof Output & string>): CHQuery<Cols, Output, Joins>

  orderBy(...specs: Array<OrderBySpec<Output>>): CHQuery<Cols, Output, Joins>

  limit(n: number): CHQuery<Cols, Output, Joins>

  offset(n: number): CHQuery<Cols, Output, Joins>

  format(fmt: "JSON" | "JSONEachRow"): CHQuery<Cols, Output, Joins>

  // ---------------------------------------------------------------------------
  // Type-safe joins with Table
  // ---------------------------------------------------------------------------

  innerJoin<JName extends string, JCols extends ColumnDefs, Alias extends string>(
    table: Table<JName, JCols>,
    alias: Alias,
    on: JoinOnCallback<Cols, JCols>,
  ): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: JCols }>

  leftJoin<JName extends string, JCols extends ColumnDefs, Alias extends string>(
    table: Table<JName, JCols>,
    alias: Alias,
    on: JoinOnCallback<Cols, JCols>,
  ): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: NullableColumnDefs<JCols> }>

  crossJoin<JName extends string, JCols extends ColumnDefs, Alias extends string>(
    table: Table<JName, JCols>,
    alias: Alias,
  ): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: JCols }>

  // ---------------------------------------------------------------------------
  // Type-safe joins with subquery (CHQuery)
  // ---------------------------------------------------------------------------

  innerJoinQuery<JCols extends ColumnDefs, JOutput extends Record<string, any>, JJoins extends Record<string, ColumnDefs>, Alias extends string>(
    query: CHQuery<JCols, JOutput, JJoins>,
    alias: Alias,
    on: JoinOnCallback<Cols, OutputToColumnDefs<JOutput>>,
  ): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: OutputToColumnDefs<JOutput> }>

  leftJoinQuery<JCols extends ColumnDefs, JOutput extends Record<string, any>, JJoins extends Record<string, ColumnDefs>, Alias extends string>(
    query: CHQuery<JCols, JOutput, JJoins>,
    alias: Alias,
    on: JoinOnCallback<Cols, OutputToColumnDefs<JOutput>>,
  ): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: NullableColumnDefs<OutputToColumnDefs<JOutput>> }>

  crossJoinQuery<JCols extends ColumnDefs, JOutput extends Record<string, any>, JJoins extends Record<string, ColumnDefs>, Alias extends string>(
    query: CHQuery<JCols, JOutput, JJoins>,
    alias: Alias,
  ): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: OutputToColumnDefs<JOutput> }>

  /**
   * Add a CTE (WITH clause). The CTE SQL is prepended to the compiled query.
   * The CTE name can then be used as a table name via `from()` or in raw expressions.
   */
  withCTE(name: string, sql: string): CHQuery<Cols, Output, Joins>
}

// ---------------------------------------------------------------------------
// Type utilities for extracting output types from queries
// ---------------------------------------------------------------------------

/** Extract the Output type from a CHQuery. */
export type InferQueryOutput<Q> = Q extends CHQuery<any, infer O, any> ? O : never

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
// Qualified ColumnAccessor for joined tables (generates alias.Column SQL)
// ---------------------------------------------------------------------------

function createQualifiedColumnAccessor(alias: string): ColumnAccessor<any> {
  const cache = new Map<string, ColumnRef<string, CHType<string, any>>>()

  return new Proxy({} as ColumnAccessor<any>, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined
      let ref = cache.get(prop)
      if (!ref) {
        ref = makeColumnRef(`${alias}.${prop}`)
        cache.set(prop, ref)
      }
      return ref
    },
  })
}

// ---------------------------------------------------------------------------
// Joined ColumnAccessor — main columns + nested alias accessors
// ---------------------------------------------------------------------------

export function createJoinedColumnAccessor<
  Cols extends ColumnDefs,
  Joins extends Record<string, ColumnDefs>,
>(
  _columns: Cols,
  joinAliases: readonly string[],
  mainAlias?: string,
): JoinedColumnAccessor<Cols, Joins> {
  const cache = new Map<string, any>()
  const aliasSet = new Set(joinAliases)

  return new Proxy({} as JoinedColumnAccessor<Cols, Joins>, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined
      let cached = cache.get(prop)
      if (cached) return cached

      if (aliasSet.has(prop)) {
        // Return a nested proxy for the joined table's columns
        cached = createQualifiedColumnAccessor(prop)
        cache.set(prop, cached)
        return cached
      }

      // Main table column — qualify with alias when joins are present
      const qualifiedName = mainAlias ? `${mainAlias}.${prop}` : prop
      cached = makeColumnRef(qualifiedName)
      cache.set(prop, cached)
      return cached
    },
  })
}

// ---------------------------------------------------------------------------
// Query builder implementation
// ---------------------------------------------------------------------------

function makeQuery<
  Cols extends ColumnDefs,
  Output extends Record<string, any>,
  Joins extends Record<string, ColumnDefs>,
>(state: CHQueryState): CHQuery<Cols, Output, Joins> {
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

    // -----------------------------------------------------------------------
    // Type-safe joins with Table
    // -----------------------------------------------------------------------

    innerJoin(table, alias, onFn) {
      const mainAlias = state.tableAlias ?? state.tableName
      const mainAccessor = createQualifiedColumnAccessor(mainAlias)
      const joinedAccessor = createQualifiedColumnAccessor(alias)
      const condition = onFn(mainAccessor, joinedAccessor)

      return makeQuery({
        ...state,
        typedJoins: [
          ...state.typedJoins,
          { type: "INNER", tableName: table.name, alias, on: condition },
        ],
      }) as any
    },

    leftJoin(table, alias, onFn) {
      const mainAlias = state.tableAlias ?? state.tableName
      const mainAccessor = createQualifiedColumnAccessor(mainAlias)
      const joinedAccessor = createQualifiedColumnAccessor(alias)
      const condition = onFn(mainAccessor, joinedAccessor)

      return makeQuery({
        ...state,
        typedJoins: [
          ...state.typedJoins,
          { type: "LEFT", tableName: table.name, alias, on: condition },
        ],
      }) as any
    },

    crossJoin(table, alias) {
      return makeQuery({
        ...state,
        typedJoins: [
          ...state.typedJoins,
          { type: "CROSS", tableName: table.name, alias },
        ],
      }) as any
    },

    // -----------------------------------------------------------------------
    // Type-safe joins with subquery (CHQuery)
    // -----------------------------------------------------------------------

    innerJoinQuery(query, alias, onFn) {
      const mainAlias = state.tableAlias ?? state.fromQueryAlias ?? state.tableName
      const mainAccessor = createQualifiedColumnAccessor(mainAlias)
      const joinedAccessor = createQualifiedColumnAccessor(alias)
      const condition = onFn(mainAccessor, joinedAccessor)

      return makeQuery({
        ...state,
        typedJoins: [
          ...state.typedJoins,
          { type: "INNER", innerQuery: query, alias, on: condition },
        ],
      }) as any
    },

    leftJoinQuery(query, alias, onFn) {
      const mainAlias = state.tableAlias ?? state.fromQueryAlias ?? state.tableName
      const mainAccessor = createQualifiedColumnAccessor(mainAlias)
      const joinedAccessor = createQualifiedColumnAccessor(alias)
      const condition = onFn(mainAccessor, joinedAccessor)

      return makeQuery({
        ...state,
        typedJoins: [
          ...state.typedJoins,
          { type: "LEFT", innerQuery: query, alias, on: condition },
        ],
      }) as any
    },

    crossJoinQuery(query, alias) {
      return makeQuery({
        ...state,
        typedJoins: [
          ...state.typedJoins,
          { type: "CROSS", innerQuery: query, alias },
        ],
      }) as any
    },

    withCTE(name, sql) {
      return makeQuery({
        ...state,
        ctes: [...state.ctes, { name, sql }],
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function from<Name extends string, Cols extends ColumnDefs>(
  table: Table<Name, Cols>,
  alias?: string,
): CHQuery<Cols, {}, {}> {
  return makeQuery({
    tableName: table.name,
    tableAlias: alias,
    columns: table.columns,
    groupByKeys: [],
    orderBySpecs: [],
    typedJoins: [],
    ctes: [],
  })
}

/**
 * Start a query from another query's output (type-safe subquery in FROM).
 *
 * Usage:
 *   const inner = CH.from(Traces).select($ => ({ traceId: $.TraceId }))
 *   const outer = CH.fromQuery(inner, "sub")
 *     .select($ => ({ id: $.sub.traceId })) // fully typed!
 */
export function fromQuery<
  InnerCols extends ColumnDefs,
  InnerOutput extends Record<string, any>,
  InnerJoins extends Record<string, ColumnDefs>,
  Alias extends string,
>(
  query: CHQuery<InnerCols, InnerOutput, InnerJoins>,
  alias: Alias,
): CHQuery<OutputToColumnDefs<InnerOutput>, {}, {}> {
  return makeQuery({
    tableName: alias,
    columns: {},
    groupByKeys: [],
    orderBySpecs: [],
    typedJoins: [],
    ctes: [],
    fromQuery: query,
    fromQueryAlias: alias,
  })
}
