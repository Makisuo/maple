// ---------------------------------------------------------------------------
// Query Compilation
//
// Compiles a CHQuery + params into a SQL string by:
// 1. Creating a ColumnAccessor proxy for the table
// 2. Evaluating the selectFn to get aliased SqlFragments
// 3. Evaluating the whereFn (with params resolved) to get Conditions
// 4. Assembling into SqlQuery and calling the existing compileQuery()
// ---------------------------------------------------------------------------

import type { ColumnDefs } from "./types"
import type { CHQuery } from "./query"
import { createColumnAccessor } from "./query"
import { aliased } from "./expr"
import { raw, ident } from "../sql/sql-fragment"
import { compileQuery, type SqlQuery } from "../sql/sql-query"

// ---------------------------------------------------------------------------
// CompiledQuery — bundles the SQL string with its output type so consumers
// never need to cast manually.
// ---------------------------------------------------------------------------

export interface CompiledQuery<Output> {
  readonly sql: string
  /** Type-safe cast of raw query results. The cast is sound because the
   *  Output type is derived from the SELECT clause that produced the SQL. */
  readonly castRows: (rows: ReadonlyArray<Record<string, unknown>>) => ReadonlyArray<Output>
}

export function compileCH<
  Cols extends ColumnDefs,
  Output extends Record<string, any>,
  Params extends Record<string, any>,
>(
  query: CHQuery<Cols, Output, Params>,
  params: Params,
): CompiledQuery<Output> {
  const state = query._state
  const $ = createColumnAccessor(state.columns)

  // SELECT
  const selectExprs = state.selectFn ? state.selectFn($) : {}
  const selectFragments = Object.entries(selectExprs).map(([alias, expr]) =>
    aliased(expr, alias),
  )

  if (selectFragments.length === 0) {
    throw new Error("CHQuery: select() is required")
  }

  // WHERE — resolve params by injecting values into the accessor
  const whereConditions = state.whereFn ? state.whereFn($) : []
  const whereFragments = whereConditions
    .filter((c): c is NonNullable<typeof c> => c != null)
    .map((c) => c.toFragment())

  // Resolve param placeholders in the compiled SQL
  const sqlQuery: SqlQuery = {
    select: selectFragments,
    from: ident(state.tableName),
    where: whereFragments,
    groupBy: state.groupByKeys.map((k) => raw(k)),
    orderBy: state.orderBySpecs.map(([k, dir]) => raw(`${k} ${dir.toUpperCase()}`)),
    limit: state.limitValue != null ? raw(String(Math.round(state.limitValue))) : undefined,
    format: state.formatValue,
  }

  let sql = compileQuery(sqlQuery)

  // Replace param placeholders with resolved values
  for (const [name, value] of Object.entries(params)) {
    const placeholder = `__PARAM_${name}__`
    const resolved = resolveParam(value)
    sql = sql.replaceAll(placeholder, resolved)
  }

  return {
    sql,
    castRows: (rows) => rows as unknown as ReadonlyArray<Output>,
  }
}

function resolveParam(value: unknown): string {
  if (typeof value === "string") {
    // Escape for ClickHouse string literal
    const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
    return `'${escaped}'`
  }
  if (typeof value === "number") return String(Math.round(value))
  if (typeof value === "boolean") return value ? "1" : "0"
  return String(value)
}
