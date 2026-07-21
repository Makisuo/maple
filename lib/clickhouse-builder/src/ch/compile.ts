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
import { Effect, Option, Schema } from "effect"

// ---------------------------------------------------------------------------
// QueryBuilderError — tagged error for invariant violations in the DSL.
// Catchable via `Effect.catchTag("@maple/query-engine/ch/QueryBuilderError")` at the service layer.
// ---------------------------------------------------------------------------

export class QueryBuilderError extends Schema.TaggedErrorClass<QueryBuilderError>()(
	"@maple/query-engine/ch/QueryBuilderError",
	{
		code: Schema.Literals(["SelectRequired", "UnresolvedParam"]),
		message: Schema.String,
	},
) {}

export class CompiledQueryDecodeError extends Schema.TaggedErrorClass<CompiledQueryDecodeError>()(
	"@maple/query-engine/ch/CompiledQueryDecodeError",
	{
		message: Schema.String,
		rowIndex: Schema.Number,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

// ---------------------------------------------------------------------------
// CompiledQuery — bundles the SQL string with its output type so consumers
// never need to cast manually.
// ---------------------------------------------------------------------------

export interface CompiledQuery<Output> {
	readonly sql: string
	/** Execution-routing metadata: `"ingest"` marks a query whose datasource only
	 *  exists in the managed ingest pipeline (declared via `.routing("ingest")` at
	 *  the query definition), so executors read it there instead of a per-org
	 *  warehouse override. */
	readonly routing?: "ingest"
	/** Type-safe cast of raw query results. The cast is sound because the
	 *  Output type is derived from the SELECT clause that produced the SQL. */
	readonly castRows: (rows: ReadonlyArray<Record<string, unknown>>) => ReadonlyArray<Output>
	/** Runtime decode of raw query results. Queries built from handwritten SQL
	 *  should provide a row schema so schema drift is caught before consumers
	 *  read fields from `Record<string, unknown>`. */
	readonly decodeRows: (
		rows: ReadonlyArray<Record<string, unknown>>,
	) => Effect.Effect<ReadonlyArray<Output>, CompiledQueryDecodeError>
	/** Runtime decode of only the first row, returned as an Option so callers
	 *  don't need to hand-roll `rows[0] ?? null` at every point lookup. */
	readonly decodeFirstRow: (
		rows: ReadonlyArray<Record<string, unknown>>,
	) => Effect.Effect<Option.Option<Output>, CompiledQueryDecodeError>
}

export type CompiledQueryRowSchema<Output> = Schema.Schema<Output>

const makeCompiledQuery = <Output>(
	sql: string,
	rowSchema?: CompiledQueryRowSchema<Output>,
	routing?: "ingest",
): CompiledQuery<Output> => {
	const decodeRow = rowSchema
		? (Schema.decodeUnknownEffect(rowSchema) as (row: unknown) => Effect.Effect<Output, unknown, never>)
		: undefined

	const decodeRows: CompiledQuery<Output>["decodeRows"] = (rows) => {
		if (!rowSchema) return Effect.succeed(rows as unknown as ReadonlyArray<Output>)
		if (!decodeRow) return Effect.succeed(rows as unknown as ReadonlyArray<Output>)

		return Effect.forEach(rows, (row, index) =>
			decodeRow(row).pipe(
				Effect.mapError(
					(cause) =>
						new CompiledQueryDecodeError({
							message: `Compiled query row ${index} did not match its declared output schema`,
							rowIndex: index,
							cause,
						}),
				),
			),
		).pipe(Effect.map((decodedRows) => decodedRows as ReadonlyArray<Output>))
	}

	return {
		sql,
		...(routing === undefined ? {} : { routing }),
		castRows: (rows) => rows as unknown as ReadonlyArray<Output>,
		decodeRows,
		decodeFirstRow: (rows) => {
			const row = rows[0]
			if (row == null) return Effect.succeed(Option.none<Output>())
			if (!decodeRow) return Effect.succeed(Option.some(row as unknown as Output))

			return decodeRow(row).pipe(
				Effect.map(Option.some),
				Effect.mapError(
					(cause) =>
						new CompiledQueryDecodeError({
							message: "Compiled query row 0 did not match its declared output schema",
							rowIndex: 0,
							cause,
						}),
				),
			)
		},
	}
}

/**
 * Explicit constructor for SQL that cannot yet be expressed through the typed
 * DSL. Prefer `compile(CH.from(...))`; use this only for deliberately
 * handwritten ClickHouse SQL and pass `rowSchema` whenever possible.
 */
export const unsafeCompiledQuery = <Output>(args: {
	readonly sql: string
	readonly rowSchema?: CompiledQueryRowSchema<Output>
	readonly routing?: "ingest"
}): CompiledQuery<Output> => makeCompiledQuery(args.sql, args.rowSchema, args.routing)

export function compileCH<
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
	Joins extends Record<string, ColumnDefs>,
	Params extends Record<string, any>,
>(
	query: CHQuery<Cols, Output, Joins>,
	params: Params,
	options?: { skipFormat?: boolean; rowSchema?: CompiledQueryRowSchema<Output> },
): CompiledQuery<Output> {
	const state = query._state

	// Build column accessor — joined or simple depending on joins
	const joinAliases = state.typedJoins.map((j) => j.alias)
	const hasJoins = joinAliases.length > 0
	const mainAlias = hasJoins ? (state.tableAlias ?? state.fromQueryAlias ?? state.tableName) : undefined

	const $ = hasJoins
		? createJoinedColumnAccessor(state.columns, joinAliases, mainAlias)
		: createColumnAccessor(state.columns)

	// SELECT
	const selectExprs = state.selectFn ? state.selectFn($) : {}
	const selectFragments = Object.entries(selectExprs).map(([alias, expr]) => aliased(expr, alias))

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
	} else if (state.fromUnion) {
		// Compile the inner union without an outer FORMAT — the outer query
		// owns formatting. Strips a trailing `\nFORMAT <fmt>` defensively.
		const innerCompiled = compileUnion(state.fromUnion, params)
		const innerSql = innerCompiled.sql.replace(/\nFORMAT \w+$/, "")
		fromFragment = raw(`(\n${innerSql}\n) AS ${state.fromQueryAlias}`)
	} else if (state.tableAlias) {
		fromFragment = raw(`${state.tableName} AS ${state.tableAlias}`)
	} else {
		fromFragment = ident(state.tableName)
	}

	// JOINs
	const joins =
		state.typedJoins.length > 0
			? state.typedJoins.map((j) => {
					let tableSql: string
					if (j.innerQuery) {
						const compiled = compileCH(j.innerQuery, params, { skipFormat: true })
						tableSql = `(${compiled.sql})`
					} else if (j.tableName) {
						tableSql = j.tableName
					} else {
						throw new QueryBuilderError({
							code: "SelectRequired",
							message: "TypedJoin: missing table or query",
						})
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
		...makeCompiledQuery<Output>(sql, options?.rowSchema, state.routingValue),
	}
}

// ---------------------------------------------------------------------------
// UNION ALL compilation
// ---------------------------------------------------------------------------

export function compileUnion<Output extends Record<string, any>, Params extends Record<string, any>>(
	union: CHUnionQuery<Output>,
	params: Params,
): CompiledQuery<Output> {
	const state = union._state

	// Compile each sub-query without FORMAT
	const subSqls = state.queries.map((q) => compileCH(q, params, { skipFormat: true }).sql)

	let sql = subSqls.join("\nUNION ALL\n")

	// Wrap in outer SELECT if ordering/pagination is needed
	const hasOuter =
		state.outerOrderBySpecs.length > 0 || state.outerLimitValue != null || state.outerOffsetValue != null

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
		...makeCompiledQuery<Output>(sql),
	}
}

function resolveParam(value: unknown): string {
	if (typeof value === "string") return `'${escapeClickHouseString(value)}'`
	if (typeof value === "number") return String(Math.round(value))
	if (typeof value === "boolean") return value ? "1" : "0"
	return String(value)
}
