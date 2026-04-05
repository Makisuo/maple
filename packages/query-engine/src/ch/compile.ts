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
import type { CHUnionQuery } from "./union"
import { createColumnAccessor } from "./query"
import { aliased } from "./expr"
import { raw, ident, escapeClickHouseString } from "../sql/sql-fragment"
import { compileQuery, type SqlQuery } from "../sql/sql-query"
import { Schema } from "effect"

// ---------------------------------------------------------------------------
// QueryBuilderError — tagged error for invariant violations in the DSL.
// Catchable via `Effect.catchTag("QueryBuilderError")` at the service layer.
// ---------------------------------------------------------------------------

export class QueryBuilderError extends Schema.TaggedErrorClass<QueryBuilderError>()(
  "QueryBuilderError",
  {
    code: Schema.Literal("SelectRequired", "UnresolvedParam"),
    message: Schema.String,
  },
) {}

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
  options?: { skipFormat?: boolean },
): CompiledQuery<Output> {
  const state = query._state
  const $ = createColumnAccessor(state.columns)

  // SELECT
  const selectExprs = state.selectFn ? state.selectFn($) : {}
  const selectFragments = Object.entries(selectExprs).map(([alias, expr]) =>
    aliased(expr, alias),
  )

  if (selectFragments.length === 0) {
    throw new QueryBuilderError({ code: "SelectRequired", message: "CHQuery: select() is required" })
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
    offset: state.offsetValue != null ? raw(String(Math.round(state.offsetValue))) : undefined,
    format: options?.skipFormat ? undefined : state.formatValue,
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

// ---------------------------------------------------------------------------
// UNION ALL compilation
// ---------------------------------------------------------------------------

export function compileUnion<
  Output extends Record<string, any>,
  Params extends Record<string, any>,
>(
  union: CHUnionQuery<Output, Params>,
  params: Params,
): CompiledQuery<Output> {
  const state = union._state

  // Compile each sub-query without FORMAT
  const subSqls = state.queries.map((q) =>
    compileCH(q, params, { skipFormat: true }).sql,
  )

  let sql = subSqls.join("\nUNION ALL\n")

  // Wrap in outer SELECT if ordering/pagination is needed
  const hasOuter =
    state.outerOrderBySpecs.length > 0 ||
    state.outerLimitValue != null ||
    state.outerOffsetValue != null

  if (hasOuter) {
    sql = `SELECT * FROM (\n${sql}\n)`
    if (state.outerOrderBySpecs.length > 0) {
      sql += `\nORDER BY ${state.outerOrderBySpecs.map(([k, dir]) => `${k} ${dir.toUpperCase()}`).join(", ")}`
    }
    if (state.outerLimitValue != null) {
      sql += `\nLIMIT ${Math.round(state.outerLimitValue)}`
    }
    if (state.outerOffsetValue != null) {
      sql += `\nOFFSET ${Math.round(state.outerOffsetValue)}`
    }
  }

  if (state.formatValue) {
    sql += `\nFORMAT ${state.formatValue}`
  }

  return {
    sql,
    castRows: (rows) => rows as unknown as ReadonlyArray<Output>,
  }
}

function resolveParam(value: unknown): string {
  if (typeof value === "string") return `'${escapeClickHouseString(value)}'`
  if (typeof value === "number") return String(Math.round(value))
  if (typeof value === "boolean") return value ? "1" : "0"
  return String(value)
}
