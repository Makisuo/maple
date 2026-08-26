// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
// Query Compilation
//
// Compiles a CHQuery + params into a SQL string by:
// 1. Creating a ColumnAccessor proxy for the table (+ joined tables)
// 2. Evaluating the selectFn to get aliased SqlFragments
// 3. Evaluating the whereFn (with params resolved) to get Conditions
// 4. Assembling into SqlQuery and calling the existing compileQuery()

import type { ColumnDefs } from "./types"
import type { CHQuery } from "./query"
import type { CHUnionQuery } from "./union"
import { createColumnAccessor, createJoinedColumnAccessor } from "./query"
import { aliased } from "./expr"
import { raw, ident, escapeClickHouseString, compile as compileSqlFragment } from "../sql/sql-fragment"
import { splitTerminalClauses } from "../sql/terminal-clauses"
import { compileQuery, type SqlQuery } from "../sql/sql-query"
import { Effect, Option, Schema } from "effect"

// QueryBuilderError — tagged error for invariant violations in the DSL.
// Catchable via `Effect.catchTag("@maple-dev/clickhouse-builder/QueryBuilderError")` at the service layer.

export class QueryBuilderError extends Schema.TaggedError<QueryBuilderError>()(
	"@maple-dev/clickhouse-builder/QueryBuilderError",
	{
		code: Schema.Literals(["SelectRequired", "UnresolvedParam", "InvalidOrderBySpec"]),
		message: Schema.String,
	},
) {}

export class CompiledQueryDecodeError extends Schema.TaggedError<CompiledQueryDecodeError>()(
	"@maple-dev/clickhouse-builder/CompiledQueryDecodeError",
	{
		message: Schema.String,
		rowIndex: Schema.Number,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

/** `orderBy` takes `[column, direction]` tuples. A bare string is the natural
 *  mistake (`.orderBy("count", "desc")`), and it is invisible without types:
 *  destructuring a string yields its first two characters, so `"count"` used to
 *  compile to `count -> "c O"`. Fail loudly instead of emitting invalid SQL. */
const orderByClause = (specs: ReadonlyArray<[string, "asc" | "desc"]>): Array<string> =>
	specs.map((spec) => {
		if (!Array.isArray(spec) || spec.length !== 2) {
			throw new QueryBuilderError({
				code: "InvalidOrderBySpec",
				message: `CHQuery: orderBy() takes [column, direction] tuples, got ${JSON.stringify(spec)}`,
			})
		}
		const [column, direction] = spec
		if (direction !== "asc" && direction !== "desc") {
			throw new QueryBuilderError({
				code: "InvalidOrderBySpec",
				message: `CHQuery: orderBy() direction must be "asc" or "desc", got ${JSON.stringify(direction)}`,
			})
		}
		return `${column} ${direction.toUpperCase()}`
	})

// CompiledQuery — bundles the SQL string with its output type so consumers
// never need to cast manually.

/**
 * Whether a compiled query is confined to one tenant.
 *
 * `"org"` means a top-level `WHERE` predicate pins the tenant column; anything
 * else is `"cross-org"` and reads every tenant the credentials can see.
 * Executors are expected to refuse `"cross-org"` on their normal read path and
 * require an explicit privileged entry point instead — which is why this is a
 * derived fact on the compiled query rather than a convention in a doc comment.
 */
export type TenantScope = "org" | "cross-org"

interface CompiledQueryBase<Output> {
	readonly sql: string
	readonly tenantScope: TenantScope
	/** Whether a `rowSchema` was supplied. Lets a catalog sweep see the queries
	 *  that decode nothing — a missing schema is otherwise invisible, because
	 *  `decodeRows` silently degrades to an identity cast. */
	readonly rowSchemaDeclared: boolean
	/** Execution-routing metadata: `"ingest"` marks a query whose datasource only
	 *  exists in the managed ingest pipeline (declared via `.routing("ingest")` at
	 *  the query definition), so executors read it there instead of a per-org
	 *  warehouse override. */
	/** Runtime decode of raw query results. Queries built from handwritten SQL
	 *  should provide a row schema so schema drift is caught before consumers
	 *  read fields from `Record<string, unknown>`. Without a schema this is an
	 *  identity cast — there is deliberately no separate `castRows`: a cast that
	 *  looked type-safe hid wire-format drift (64-bit ints arriving as strings). */
	readonly decodeRows: (
		rows: ReadonlyArray<Record<string, unknown>>,
	) => Effect.Effect<ReadonlyArray<Output>, CompiledQueryDecodeError>
	/** Runtime decode of only the first row, returned as an Option so callers
	 *  don't need to hand-roll `rows[0] ?? null` at every point lookup. */
	readonly decodeFirstRow: (
		rows: ReadonlyArray<Record<string, unknown>>,
	) => Effect.Effect<Option.Option<Output>, CompiledQueryDecodeError>
}

/**
 * Routing is a type-level fact as well as runtime metadata. An ingest-routed
 * query therefore cannot be passed accidentally to an API that may consult a
 * per-org read configuration.
 */
export type CompiledQuery<
	Output,
	Routing extends "ingest" | undefined = "ingest" | undefined,
> = CompiledQueryBase<Output> &
	(Routing extends "ingest" ? { readonly routing: "ingest" } : { readonly routing?: undefined })

export type CompiledQueryRowSchema<Output> = Schema.Schema<Output>

const makeCompiledQuery = <Output, Routing extends "ingest" | undefined>(
	sql: string,
	tenantScope: TenantScope,
	rowSchema?: CompiledQueryRowSchema<Output>,
	routing?: Routing,
): CompiledQuery<Output, Routing> => {
	const decodeRow = rowSchema
		? (Schema.decodeUnknownEffect(rowSchema) as (row: unknown) => Effect.Effect<Output, unknown, never>)
		: undefined

	const decodeRows: CompiledQueryBase<Output>["decodeRows"] = (rows) => {
		if (!rowSchema) return Effect.succeed(rows as ReadonlyArray<Output>)
		if (!decodeRow) return Effect.succeed(rows as ReadonlyArray<Output>)

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
		tenantScope,
		rowSchemaDeclared: rowSchema !== undefined,
		...(!(routing === undefined) ? { routing } : undefined),
		decodeRows,
		decodeFirstRow: (rows) => {
			const row = rows[0]
			if (row == null) return Effect.succeed(Option.none<Output>())
			if (!decodeRow) return Effect.succeed(Option.some(row as Output))

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
	} as CompiledQuery<Output, Routing>
}

/**
 * Why a query is handwritten SQL rather than a builder query.
 *
 * This union is the boundary between legitimate raw SQL and raw SQL nobody got
 * round to converting — and adding a member is the review gate. It is a one-line
 * diff in this file that a reviewer cannot miss, and it travels with the
 * definition, so it survives file moves and copy-paste into new packages in a
 * way a checked-in call-site list or a lint rule with an allowlist of paths
 * does not.
 *
 * There is deliberately no `"legacy"` or `"todo"` member. With one, the gate is
 * decorative.
 */
export type RawSqlReason =
	/**
	 * The SQL came from a user, so there is no AST to build. Isolation comes
	 * from the credential layer and a separate validation pass, not from the
	 * derived `tenantScope`.
	 */
	| "user-authored-sql"
	/**
	 * A constant zero-row result that reads no table (`SELECT … WHERE 0`). The
	 * builder always emits a FROM, and naming a real table for a query designed
	 * to touch none would be strictly worse.
	 */
	| "empty-result-stub"
	/**
	 * A `UNION ALL` of one builder compiled over two different parameter sets
	 * (a current and a previous window, say). Params are substituted once,
	 * across the whole query, at the end of `compileCH` — so a single `CHQuery`
	 * cannot carry two of them, and `unionAll` cannot express this.
	 *
	 * Scope must still be *derived* from the compiled branches rather than
	 * asserted; the branches are real compiled queries and each knows its own.
	 */
	| "param-varied-union"
	/** A test asserting executor behaviour on synthetic SQL. */
	| "test-fixture"

/**
 * Explicit constructor for SQL that cannot be expressed through the typed DSL.
 *
 * Prefer `compile(CH.from(...))`. `tenantScope` here is taken at face value —
 * there is no query AST to inspect, only a string — which is exactly why this
 * is the one place tenant scope can be *asserted* rather than derived, and why
 * every use has to name a `reason` and justify itself in a `note`.
 *
 * DDL, migrations, and another engine's file formats don't reach this function
 * at all; they never produce a `CompiledQuery`.
 */
export const unsafeCompiledQuery = <Output, Routing extends "ingest" | undefined = undefined>(args: {
	readonly sql: string
	readonly tenantScope: TenantScope
	readonly reason: RawSqlReason
	/** One sentence, at the call site, on why this instance qualifies. */
	readonly note: string
	readonly rowSchema?: CompiledQueryRowSchema<Output>
	readonly routing?: Routing
}): CompiledQuery<Output, Routing> =>
	makeCompiledQuery(args.sql, args.tenantScope, args.rowSchema, args.routing)

export function compileCH<
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
	Joins extends Record<string, ColumnDefs>,
	Routing extends "ingest" | undefined,
	Params extends Record<string, any>,
	// The row schema, not the SELECT inference, is what actually produces values
	// at runtime, so it decides the compiled query's output type. `extends Output`
	// keeps it honest: a schema may *narrow* what the builder inferred (a String
	// column decoded as a literal union) but never contradict it.
	Decoded extends Output = Output,
>(
	query: CHQuery<Cols, Output, Joins, Routing>,
	params: Params,
	options?: { skipFormat?: boolean; rowSchema?: CompiledQueryRowSchema<Decoded> },
): CompiledQuery<Decoded, Routing> {
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

	// Tenant scope is read off THIS query's top-level predicates only. A filter
	// inside `fromQuery`/`fromUnion`/a join that the outer query doesn't repeat
	// does not scope the result — that is precisely the shape (an inner-scoped
	// subquery joined to an unscoped outer) this is meant to catch. The
	// top-level list is AND-joined below, so one marked entry is sufficient.
	const hasOwnTenantPredicate = whereConditions.some((c) => c?.scopesTenant === true)

	// CTEs — resolved before the FROM below, which reads their scope. A CTE given
	// as a query is compiled here and its scope derived; one given as a string
	// carries whatever scope the caller declared.
	const resolvedCtes = state.ctes.map((c) => {
		if (c.query) {
			const compiled = compileCH(c.query, params, { skipFormat: true })
			return { name: c.name, sql: compiled.sql, tenantScope: compiled.tenantScope }
		}
		return { name: c.name, sql: c.sql ?? "", tenantScope: c.tenantScope }
	})

	// FROM clause
	let fromFragment
	// Whether the row source is itself tenant-confined. A query reading only from
	// a scoped subquery cannot see another tenant's rows even with no WHERE of
	// its own — that is the `SELECT sum(total) FROM (scoped UNION scoped)` shape.
	let fromSourceScope: TenantScope = "cross-org"
	if (state.fromQuery) {
		// Compile the inner query lazily
		const innerCompiled = compileCH(state.fromQuery, params, { skipFormat: true })
		fromSourceScope = innerCompiled.tenantScope
		fromFragment = raw(`(${innerCompiled.sql}) AS ${state.fromQueryAlias}`)
	} else if (state.fromUnion) {
		// Compile the inner union without an outer FORMAT — the outer query
		// owns formatting. Strips a trailing `\nFORMAT <fmt>` defensively.
		const innerCompiled = compileUnion(state.fromUnion, params)
		fromSourceScope = innerCompiled.tenantScope
		const innerSql = splitTerminalClauses(innerCompiled.sql).body
		fromFragment = raw(`(\n${innerSql}\n) AS ${state.fromQueryAlias}`)
	} else if (state.tableAlias) {
		fromFragment = raw(`${state.tableName} AS ${state.tableAlias}`)
	} else {
		fromFragment = ident(state.tableName)
	}

	// A FROM that names a CTE inherits the CTE's scope — derived when the CTE was
	// given as a query, declared by the caller when it arrived as a string.
	if (!state.fromQuery && !state.fromUnion) {
		const cte = resolvedCtes.find((c) => c.name === state.tableName)
		if (cte?.tenantScope === "org") fromSourceScope = "org"
	}

	// JOINs
	// Every joined source is another set of rows that can reach the output, so
	// each must be tenant-confined for the join result to be. A bare table join
	// is unconfined unless the outer query pins the tenant itself.
	let allJoinSourcesScoped = true
	const joins =
		state.typedJoins.length > 0
			? state.typedJoins.map((j) => {
					let tableSql: string
					if (j.innerQuery) {
						const compiled = compileCH(j.innerQuery, params, { skipFormat: true })
						if (compiled.tenantScope !== "org") allJoinSourcesScoped = false
						tableSql = `(${compiled.sql})`
					} else if (j.tableName) {
						allJoinSourcesScoped = false
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
		// Deliberately not fed into `hasOwnTenantPredicate`: by HAVING time the
		// rows are already aggregated, so the scan that produced them crossed
		// tenants no matter what this filters out.
		having: (state.havingFn ? state.havingFn($) : [])
			.filter((c): c is NonNullable<typeof c> => c != null)
			.map((c) => c.toFragment()),
		orderBy: orderByClause(state.orderBySpecs).map(raw),
		limit: state.limitValue != null ? raw(String(Math.round(state.limitValue))) : undefined,
		offset: state.offsetValue != null ? raw(String(Math.round(state.offsetValue))) : undefined,
		format: options?.skipFormat ? undefined : state.formatValue,
	}

	let sql = compileQuery(sqlQuery)

	// Prepend CTE definitions
	if (resolvedCtes.length > 0) {
		const cteDefs = resolvedCtes.map((c) => `${c.name} AS (\n${c.sql}\n)`).join(",\n")
		sql = `WITH ${cteDefs}\n${sql}`
	}

	// Replace param placeholders with resolved values
	for (const [name, value] of Object.entries(params)) {
		const placeholder = `__PARAM_${name}__`
		const resolved = resolveParam(value)
		sql = sql.replaceAll(placeholder, resolved)
	}

	// Scoped when this query pins the tenant itself, or when every row source it
	// reads from — the FROM and each join — is already confined to one tenant.
	const tenantScope: TenantScope =
		state.crossOrg === true
			? "cross-org"
			: hasOwnTenantPredicate || (fromSourceScope === "org" && allJoinSourcesScoped)
				? "org"
				: "cross-org"

	return makeCompiledQuery<Decoded, Routing>(
		sql,
		tenantScope,
		options?.rowSchema,
		state.routingValue as Routing,
	)
}

// UNION ALL compilation

export function compileUnion<Output extends Record<string, any>, Params extends Record<string, any>>(
	union: CHUnionQuery<Output>,
	params: Params,
	options?: { rowSchema?: CompiledQueryRowSchema<Output> },
): CompiledQuery<Output, undefined> {
	const state = union._state

	// Compile each sub-query without FORMAT
	const subQueries = state.queries.map((q) => compileCH(q, params, { skipFormat: true }))

	// UNION ALL is a disjunction: one unscoped branch leaks every tenant into the
	// result regardless of how tightly the others are filtered.
	const tenantScope: TenantScope =
		subQueries.length > 0 && subQueries.every((q) => q.tenantScope === "org") ? "org" : "cross-org"

	let sql = subQueries.map((q) => q.sql).join("\nUNION ALL\n")

	// Wrap in outer SELECT if ordering/pagination is needed
	const hasOuter =
		state.outerOrderBySpecs.length > 0 || state.outerLimitValue != null || state.outerOffsetValue != null

	if (hasOuter) {
		sql = `SELECT * FROM (\n${sql}\n)`
		if (state.outerOrderBySpecs.length > 0) {
			sql += `\nORDER BY ${orderByClause(state.outerOrderBySpecs).join(", ")}`
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

	return makeCompiledQuery<Output, undefined>(sql, tenantScope, options?.rowSchema)
}

function resolveParam(value: unknown): string {
	if (typeof value === "string") return `'${escapeClickHouseString(value)}'`
	if (typeof value === "number") return String(Math.round(value))
	if (typeof value === "boolean") return value ? "1" : "0"
	return String(value)
}
