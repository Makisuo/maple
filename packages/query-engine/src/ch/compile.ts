// ---------------------------------------------------------------------------
// Query Compilation
//
// Compiles a CHQuery + params into a SQL string by:
// 1. Creating a ColumnAccessor proxy for the table (+ joined tables)
// 2. Evaluating the selectFn to get aliased SqlFragments
// 3. Evaluating the whereFn (with params resolved) to get Conditions
// 4. Assembling into SqlQuery and calling the existing compileQuery()
// ---------------------------------------------------------------------------

import type { ColumnDefs } from "./types"
import type { CHQuery } from "./query"
import type { CHUnionQuery } from "./union"
import { createColumnAccessor, createJoinedColumnAccessor } from "./query"
import { aliased } from "./expr"
import { raw, ident, escapeClickHouseString, compile as compileSqlFragment } from "../sql/sql-fragment"
import { compileQuery, type SqlQuery } from "../sql/sql-query"
import { Schema } from "effect"

// ---------------------------------------------------------------------------
// QueryBuilderError — tagged error for invariant violations in the DSL.
// Catchable via `Effect.catchTag("QueryBuilderError")` at the service layer.
// ---------------------------------------------------------------------------

export class QueryBuilderError extends Schema.TaggedErrorClass<QueryBuilderError>()(
  "QueryBuilderError",
  {
    code: Schema.Literals(["SelectRequired", "UnresolvedParam"]),
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
  Joins extends Record<string, ColumnDefs>,
  Params extends Record<string, any>,
>(
  query: CHQuery<Cols, Output, Joins>,
  params: Params,
  options?: { skipFormat?: boolean },
): CompiledQuery<Output> {
  const state = query._state

  // Build column accessor — joined or simple depending on joins
  const joinAliases = state.typedJoins.map((j) => j.alias)
  const hasJoins = joinAliases.length > 0
  const mainAlias = hasJoins
    ? (state.tableAlias ?? state.fromQueryAlias ?? state.tableName)
    : undefined

  const $ = hasJoins
    ? createJoinedColumnAccessor(state.columns, joinAliases, mainAlias)
    : createColumnAccessor(state.columns)

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

  // FROM clause
  let fromFragment
  if (state.fromQuery) {
    // Compile the inner query lazily
    const innerCompiled = compileCH(state.fromQuery, params, { skipFormat: true })
    fromFragment = raw(`(${innerCompiled.sql}) AS ${state.fromQueryAlias}`)
  } else if (state.tableAlias) {
    fromFragment = raw(`${state.tableName} AS ${state.tableAlias}`)
  } else {
    fromFragment = ident(state.tableName)
  }

  // JOINs
  const joins = state.typedJoins.length > 0
    ? state.typedJoins.map((j) => {
        let tableSql: string
        if (j.innerQuery) {
          const compiled = compileCH(j.innerQuery, params, { skipFormat: true })
          tableSql = `(${compiled.sql})`
        } else if (j.tableName) {
          tableSql = j.tableName
        } else {
          throw new QueryBuilderError({ code: "SelectRequired", message: "TypedJoin: missing table or query" })
        }

        return {
          type: j.type,
          table: tableSql,
          alias: j.alias,
          on: j.on ? compileSqlFragment(j.on.toFragment()) : undefined,
        }
      })
    : undefined

  const sqlQuery: SqlQuery = {
    select: selectFragments,
    from: fromFragment,
    joins,
    where: whereFragments,
    groupBy: state.groupByKeys.map((k) => raw(k)),
    orderBy: state.orderBySpecs.map(([k, dir]) => raw(`${k} ${dir.toUpperCase()}`)),
    limit: state.limitValue != null ? raw(String(Math.round(state.limitValue))) : undefined,
    offset: state.offsetValue != null ? raw(String(Math.round(state.offsetValue))) : undefined,
    format: options?.skipFormat ? undefined : state.formatValue,
  }

  let sql = compileQuery(sqlQuery)

  // Prepend CTE definitions
  if (state.ctes.length > 0) {
    const cteDefs = state.ctes.map((c) => `${c.name} AS (\n${c.sql}\n)`).join(",\n")
    sql = `WITH ${cteDefs}\n${sql}`
  }

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
  union: CHUnionQuery<Output>,
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
