// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
// Query Compilation
//
// Compiles a CHQuery + params into a SQL string by:
// 1. Creating a ColumnAccessor proxy for the table (+ joined tables)
// 2. Evaluating the selectFn to get aliased SqlFragments
// 3. Evaluating the whereFn (with params resolved) to get Conditions
// 4. Assembling into SqlQuery and calling the existing compileQuery()

import type { CHType, ColumnDefs } from "./types"
import type { CHQuery, CHQueryState } from "./query"
import type { CHUnionQuery } from "./union"
import { createColumnAccessor, createJoinedColumnAccessor } from "./query"
import { aliased } from "./expr"
import { raw, ident, escapeClickHouseString, compile as compileSqlFragment } from "../sql/sql-fragment"
import { splitTerminalClauses } from "../sql/terminal-clauses"
import { compileQuery, type SqlQuery } from "../sql/sql-query"
import { PARAM_PLACEHOLDER_PATTERN, paramSchema, type ParamKind } from "./param"
import { encodeLiteral } from "./literal"
import { Effect, Option, Schema } from "effect"
import { QueryBuilderError } from "./errors"

// `QueryBuilderError` moved to ./errors so `expr.ts` can raise it too; still
// exported from here, which is where every caller imports it from.
export { QueryBuilderError } from "./errors"

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
 * `"tenant"` means a top-level `WHERE` predicate pins the table's declared
 * tenant column; anything else is `"cross-tenant"` and reads every tenant the
 * credentials can see. Executors are expected to refuse `"cross-tenant"` on
 * their normal read path and require an explicit privileged entry point
 * instead — which is why this is a derived fact on the compiled query rather
 * than a convention in a doc comment.
 *
 * A table that declares no `tenantColumn` has no row-level tenancy to pin, so
 * everything it compiles to is `"cross-tenant"`.
 */
export type TenantScope = "tenant" | "cross-tenant"

interface CompiledQueryBase<Output> {
	readonly sql: string
	readonly tenantScope: TenantScope
	/** Whether the query has a row schema at all, declared or derived. Lets a
	 *  catalog sweep see the queries that decode nothing — a missing schema is
	 *  otherwise invisible, because `decodeRows` degrades to an identity cast. */
	readonly rowSchemaDeclared: boolean
	/**
	 * Where that schema came from.
	 *
	 * `"derived"` is the normal case: every selected expression knew its own
	 * column type, so the row schema is the SELECT. `"declared"` means a caller
	 * passed one, which also lets it *narrow* what the builder inferred.
	 * `"none"` means at least one selected expression had no type to read —
	 * a `rawExpr`, a `dynamicColumn`, or an un-annotated custom function — and
	 * nothing validates the rows.
	 */
	readonly rowSchemaSource: "declared" | "derived" | "none"
	/** Execution-routing metadata, set by `.routing(tag)` at the query
	 *  definition. The tag is opaque to the builder — executors give it meaning. */
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
 * Routing is a type-level fact as well as runtime metadata, so a query tagged
 * for one backend cannot be passed accidentally to an API that reads from
 * another.
 */
export type CompiledQuery<
	Output,
	Routing extends string | undefined = string | undefined,
> = CompiledQueryBase<Output> &
	(Routing extends string ? { readonly routing: Routing } : { readonly routing?: undefined })

export type CompiledQueryRowSchema<Output> = Schema.Schema<Output>

const makeCompiledQuery = <Output, Routing extends string | undefined>(
	sql: string,
	tenantScope: TenantScope,
	rowSchemaSource: "declared" | "derived" | "none",
	/** Built on first decode: a derived schema costs a `Schema.Struct` per
	 *  compile otherwise, and most compiled queries are never decoded. */
	getRowSchema: (() => CompiledQueryRowSchema<Output> | undefined) | undefined,
	routing?: Routing,
): CompiledQuery<Output, Routing> => {
	let cachedDecodeRow: ((row: unknown) => Effect.Effect<Output, unknown, never>) | undefined
	let decoderBuilt = false
	const decodeRow = () => {
		if (!decoderBuilt) {
			decoderBuilt = true
			const rowSchema = getRowSchema?.()
			cachedDecodeRow = rowSchema
				? (Schema.decodeUnknownEffect(rowSchema) as (
						row: unknown,
					) => Effect.Effect<Output, unknown, never>)
				: undefined
		}
		return cachedDecodeRow
	}

	const decodeRows: CompiledQueryBase<Output>["decodeRows"] = (rows) => {
		const decode = decodeRow()
		if (!decode) return Effect.succeed(rows as ReadonlyArray<Output>)

		return Effect.forEach(rows, (row, index) =>
			decode(row).pipe(
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
		rowSchemaDeclared: rowSchemaSource !== "none",
		rowSchemaSource,
		...(!(routing === undefined) ? { routing } : undefined),
		decodeRows,
		decodeFirstRow: (rows) => {
			const row = rows[0]
			if (row == null) return Effect.succeed(Option.none<Output>())
			const decode = decodeRow()
			if (!decode) return Effect.succeed(Option.some(row as Output))

			return decode(row).pipe(
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
 * The builder does not enumerate the legitimate reasons — that is a policy of
 * the codebase using it. Declare a string-literal union of your own and pass it
 * as `Reason` (or wrap `unsafeCompiledQuery` in a function that pins it) to make
 * adding a reason a reviewable one-line diff.
 */
export type RawSqlReason = string

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
export const unsafeCompiledQuery = <
	Output,
	Routing extends string | undefined = undefined,
	Reason extends string = string,
>(args: {
	readonly sql: string
	readonly tenantScope: TenantScope
	readonly reason: Reason
	/** One sentence, at the call site, on why this instance qualifies. */
	readonly note: string
	readonly rowSchema?: CompiledQueryRowSchema<Output>
	readonly routing?: Routing
}): CompiledQuery<Output, Routing> =>
	makeCompiledQuery(
		args.sql,
		args.tenantScope,
		args.rowSchema === undefined ? "none" : "declared",
		() => args.rowSchema,
		args.routing,
	)

export function compileCH<
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
	Joins extends Record<string, ColumnDefs>,
	Routing extends string | undefined,
	Params extends Record<string, any>,
	// The row schema, not the SELECT inference, is what actually produces values
	// at runtime, so it decides the compiled query's output type. `extends Output`
	// keeps it honest: a schema may *narrow* what the builder inferred (a String
	// column decoded as a literal union) but never contradict it.
	Decoded extends Output = Output,
>(
	query: CHQuery<Cols, Output, Joins, Routing>,
	params: Params,
	options?: {
		skipFormat?: boolean
		rowSchema?: CompiledQueryRowSchema<Decoded>
		/** Leave `__PARAM_…__` placeholders in the SQL instead of resolving them.
		 *  For fragments spliced into a larger query — a subquery condition — whose
		 *  params are resolved by the outer compilation pass. */
		deferParams?: boolean
	},
): CompiledQuery<Decoded, Routing> {
	const state = query._state
	const deferParams = options?.deferParams === true

	// Build column accessor — joined or simple depending on joins
	const joinAliases = state.typedJoins.map((j) => j.alias)
	const hasJoins = joinAliases.length > 0
	const mainAlias = hasJoins ? (state.tableAlias ?? state.fromQueryAlias ?? state.tableName) : undefined

	const joinTenantColumns = Object.fromEntries(state.typedJoins.map((j) => [j.alias, j.tenantColumn]))

	const $ = hasJoins
		? createJoinedColumnAccessor(
				state.columns,
				joinAliases,
				mainAlias,
				state.tenantColumn,
				joinTenantColumns,
			)
		: createColumnAccessor(state.columns, state.tenantColumn)

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
			const compiled = compileCH(c.query, params, { skipFormat: true, deferParams })
			return { name: c.name, sql: compiled.sql, tenantScope: compiled.tenantScope }
		}
		return { name: c.name, sql: c.sql ?? "", tenantScope: c.tenantScope }
	})

	// FROM clause
	let fromFragment
	// Whether the row source is itself tenant-confined. A query reading only from
	// a scoped subquery cannot see another tenant's rows even with no WHERE of
	// its own — that is the `SELECT sum(total) FROM (scoped UNION scoped)` shape.
	let fromSourceScope: TenantScope = "cross-tenant"
	if (state.fromQuery) {
		// Compile the inner query lazily
		const innerCompiled = compileCH(state.fromQuery, params, { skipFormat: true, deferParams })
		fromSourceScope = innerCompiled.tenantScope
		fromFragment = raw(`(${innerCompiled.sql}) AS ${state.fromQueryAlias}`)
	} else if (state.fromUnion) {
		// Compile the inner union without an outer FORMAT — the outer query
		// owns formatting. Strips a trailing `\nFORMAT <fmt>` defensively.
		const innerCompiled = compileUnion(state.fromUnion, params, { deferParams })
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
		if (cte?.tenantScope === "tenant") fromSourceScope = "tenant"
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
						const compiled = compileCH(j.innerQuery, params, { skipFormat: true, deferParams })
						if (compiled.tenantScope !== "tenant") allJoinSourcesScoped = false
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

	if (!deferParams) sql = resolveParams(sql, params)

	// Scoped when this query pins the tenant itself, or when every row source it
	// reads from — the FROM and each join — is already confined to one tenant.
	const tenantScope: TenantScope =
		state.crossTenant === true
			? "cross-tenant"
			: hasOwnTenantPredicate || (fromSourceScope === "tenant" && allJoinSourcesScoped)
				? "tenant"
				: "cross-tenant"

	return makeCompiledQuery<Decoded, Routing>(
		sql,
		tenantScope,
		options?.rowSchema !== undefined ? "declared" : deriveRowSchema(selectExprs) ? "derived" : "none",
		() =>
			options?.rowSchema ??
			(deriveRowSchema(selectExprs) as CompiledQueryRowSchema<Decoded> | undefined),
		state.routingValue as Routing,
	)
}

/**
 * The column accessor a query's callbacks see.
 *
 * Shared with `selectExprsOf` below, which needs the same accessor to read a
 * query's output schemas without compiling it.
 */
function makeAccessor(state: CHQueryState): any {
	const joinAliases = state.typedJoins.map((j) => j.alias)
	const hasJoins = joinAliases.length > 0
	if (!hasJoins) return createColumnAccessor(columnsOf(state), state.tenantColumn)

	const mainAlias = state.tableAlias ?? state.fromQueryAlias ?? state.tableName
	return createJoinedColumnAccessor(
		columnsOf(state),
		joinAliases,
		mainAlias,
		state.tenantColumn,
		Object.fromEntries(state.typedJoins.map((j) => [j.alias, j.tenantColumn])),
		Object.fromEntries(state.typedJoins.map((j) => [j.alias, j.columns])),
	)
}

/**
 * A FROM-subquery's columns are its inner SELECT, which only exists as
 * expressions. Reading their schemas back out is what lets a query built on a
 * subquery still derive a row schema instead of falling off at the boundary.
 */
function columnsOf(state: CHQueryState): ColumnDefs {
	if (Object.keys(state.columns).length > 0) return state.columns

	const inner = state.fromQuery ?? state.fromUnion?._state.queries[0]
	const innerExprs = inner ? selectExprsOf(inner) : undefined
	if (innerExprs === undefined) return state.columns

	const synthesized: Record<string, CHType<"Inferred", any, any>> = {}
	for (const [alias, expr] of Object.entries(innerExprs)) {
		const schema = (expr as { readonly schema?: Schema.Codec<any, any> } | null)?.schema
		if (schema === undefined) continue
		synthesized[alias] = { _tag: "Inferred", sql: "", schema, literalSchema: schema }
	}
	return synthesized
}

/** Evaluate a query's SELECT callback without compiling it. */
function selectExprsOf(query: CHQuery<any, any, any>): Record<string, unknown> | undefined {
	const state = query._state
	return state.selectFn ? state.selectFn(makeAccessor(state)) : undefined
}

/**
 * Fold the selected expressions' own schemas into the query's row schema.
 *
 * All or nothing on purpose: one field without a schema — a `rawExpr`, a
 * `dynamicColumn`, a custom function that never declared its result type —
 * means the builder cannot describe the row, and inventing a permissive schema
 * for that field would hand back something that looks validated and is not.
 */
const deriveRowSchema = (selectExprs: Record<string, unknown>): Schema.Codec<any, any> | undefined => {
	const fields: Record<string, Schema.Codec<any, any>> = {}
	for (const [alias, expr] of Object.entries(selectExprs)) {
		const schema = (expr as { readonly schema?: Schema.Codec<any, any> } | null)?.schema
		if (schema === undefined) return undefined
		fields[alias] = schema
	}
	return Schema.Struct(fields)
}

// UNION ALL compilation

export function compileUnion<Output extends Record<string, any>, Params extends Record<string, any>>(
	union: CHUnionQuery<Output>,
	params: Params,
	options?: { rowSchema?: CompiledQueryRowSchema<Output>; deferParams?: boolean },
): CompiledQuery<Output, undefined> {
	const state = union._state
	const deferParams = options?.deferParams === true

	// Compile each sub-query without FORMAT
	const subQueries = state.queries.map((q) => compileCH(q, params, { skipFormat: true, deferParams }))

	// UNION ALL is a disjunction: one unscoped branch leaks every tenant into the
	// result regardless of how tightly the others are filtered.
	const tenantScope: TenantScope =
		subQueries.length > 0 && subQueries.every((q) => q.tenantScope === "tenant")
			? "tenant"
			: "cross-tenant"

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

	// A union decodes as its branches do — every branch shares one Output shape,
	// so the first branch speaks for the rest.
	const firstBranch = state.queries[0]
	const branchExprs = firstBranch ? selectExprsOf(firstBranch) : undefined
	const derived = branchExprs ? deriveRowSchema(branchExprs) : undefined

	return makeCompiledQuery<Output, undefined>(
		sql,
		tenantScope,
		options?.rowSchema !== undefined ? "declared" : derived ? "derived" : "none",
		() => options?.rowSchema ?? (derived as CompiledQueryRowSchema<Output> | undefined),
	)
}

/**
 * Substitute every `__PARAM_<kind>_<name>__` placeholder with its value.
 *
 * Params are resolved here rather than sent as ClickHouse query parameters, so
 * a value that never arrives, or arrives as the wrong type, would otherwise
 * become part of the SQL text: a missing param used to ship the placeholder
 * itself to the server, and a `Date` handed to a dateTime param used to
 * stringify as `Thu Jan 01 2026 …`. Both are now compile-time failures.
 *
 * Params the query doesn't mention are ignored — one bag of params is commonly
 * shared across a family of queries.
 */
function resolveParams(sql: string, params: Record<string, unknown>): string {
	const missing: Array<string> = []

	const resolved = sql.replace(PARAM_PLACEHOLDER_PATTERN, (placeholder, kind: string, name: string) => {
		if (!(name in params)) {
			missing.push(name)
			return placeholder
		}
		return resolveParam(kind as ParamKind, name, params[name])
	})

	if (missing.length > 0) {
		throw new QueryBuilderError({
			code: "UnresolvedParam",
			message: `compile: no value given for param${missing.length > 1 ? "s" : ""} ${missing
				.map((n) => `'${n}'`)
				.join(", ")}`,
		})
	}

	return resolved
}

/**
 * A param value as a ClickHouse literal, through its declared type's codec.
 *
 * The same schema that decodes a column of that type runs backwards here, so
 * the two directions cannot drift: a `DateTime` param and a `DateTime` column
 * agree on the literal by construction, not by two functions being kept in sync.
 */
function resolveParam(kind: ParamKind, name: string, value: unknown): string {
	const schema = paramSchema(kind)
	if (schema === undefined) {
		// Only reachable from a hand-written placeholder naming a kind nothing
		// declared: `param.of` registers its type before it can reach any SQL.
		throw new QueryBuilderError({
			code: "InvalidParamValue",
			message: `compile: param '${name}' has an unknown type '${kind}'`,
		})
	}
	return encodeLiteral(schema, value, `param '${name}' (${kind})`)
}
