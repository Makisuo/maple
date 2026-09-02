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
import { PARAM_MARKER_PREFIX, PARAM_PLACEHOLDER_PATTERN, paramSchema, type ParamKind } from "./param"
import { encodeLiteral } from "./literal"
import { Effect, Option, Schema } from "effect"
import { QueryBuilderDefect, QueryBuilderError } from "./errors"

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

export class CompiledQueryEncodeError extends Schema.TaggedError<CompiledQueryEncodeError>()(
	"@maple-dev/clickhouse-builder/CompiledQueryEncodeError",
	{
		message: Schema.String,
		rowIndex: Schema.Number,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

/** `orderBy` takes `[column, direction]` tuples. A bare string is the natural
 *  mistake (`.orderBy("count", "desc")`), and it is invisible without types:
 *  destructuring a string yields its first two characters, so `"count"` used to
 *  compile to `count -> "c O"`. Fail loudly instead of emitting invalid SQL —
 *  as a defect, because the specs are written at the query definition and no
 *  runtime value can steer them. */
const orderByClause = (specs: ReadonlyArray<[string, "asc" | "desc"]>): Array<string> =>
	specs.map((spec) => {
		if (!Array.isArray(spec) || spec.length !== 2) {
			throw new QueryBuilderDefect({
				message: `CHQuery: orderBy() takes [column, direction] tuples, got ${JSON.stringify(spec)}`,
			})
		}
		const [column, direction] = spec
		if (direction !== "asc" && direction !== "desc") {
			throw new QueryBuilderDefect({
				message: `CHQuery: orderBy() direction must be "asc" or "desc", got ${JSON.stringify(direction)}`,
			})
		}
		return `${column} ${direction.toUpperCase()}`
	})

// CompiledQuery — bundles the SQL string with its output type so consumers
// never need to cast manually.

/**
 * How widely a compiled query reads across tenants.
 *
 * `"single-tenant"` means a top-level `WHERE` predicate pins the table's
 * declared tenant column, or every row source the query reads is already
 * confined to one tenant. `"cross-tenant"` means the table HAS a tenant column
 * and this query did not pin it, so the read spans every tenant the credentials
 * can see. Executors are expected to refuse `"cross-tenant"` on their normal
 * read path and require an explicit privileged entry point instead — which is
 * why this is a derived fact on the compiled query rather than a convention in
 * a doc comment.
 *
 * `"untenanted"` is the third, different fact: the sources declare no
 * `tenantColumn` at all, so there is no row-level tenancy to pin and none to
 * leak. A dimension or lookup table is the usual case. It is deliberately not
 * folded into `"cross-tenant"` — an executor that refuses cross-tenant reads
 * would otherwise refuse every query over such a table, and "reads every
 * tenant" and "has no tenants" are not the same thing to audit.
 */
export type TenantScope = "single-tenant" | "cross-tenant" | "untenanted"

/** A CTE after its body is SQL and its scope is known. */
interface ResolvedCte {
	readonly name: string
	readonly sql: string
	readonly tenantScope: TenantScope | undefined
}

interface CompiledQueryBase<Output> {
	readonly sql: string
	readonly tenantScope: TenantScope
	/**
	 * Where the query's row schema came from, or `"none"` if it has none.
	 *
	 * Lets a catalog sweep see the queries that decode nothing — a missing
	 * schema is otherwise invisible, because `decodeRows` degrades to an
	 * identity cast.
	 *
	 * `"derived"` is the normal case: every selected expression knew its own
	 * column type, so the row schema is the SELECT. `"declared"` means a caller
	 * passed one, which also lets it *narrow* what the builder inferred.
	 * `"none"` means at least one selected expression had no type to read —
	 * a `rawExpr`, a `dynamicColumn`, or an un-annotated custom function — and
	 * nothing validates the rows.
	 */
	readonly rowSchemaSource: "declared" | "derived" | "none"
	/**
	 * The selected aliases that had no type to read, when `rowSchemaSource` is
	 * `"none"`. Empty otherwise.
	 *
	 * Derivation is all-or-nothing — one untyped field means the builder cannot
	 * describe the row — so "this query decodes nothing" is otherwise a dead end
	 * for whoever has to fix it. This names the columns to type.
	 */
	readonly untypedColumns: ReadonlyArray<string>
	/**
	 * How a *declared* row schema disagrees with the SELECT, when it does.
	 *
	 * A declared schema replaces the derived one wholesale, which is what makes
	 * narrowing possible — and what makes drift invisible: a schema that has
	 * fallen behind the query it describes still decodes, silently dropping the
	 * columns it forgot and demanding ones the SELECT no longer emits. The
	 * builder knows both shapes at compile time, so it says so here rather than
	 * discarding the one it inferred.
	 *
	 * `undefined` when there is nothing to compare — no declared schema, or a
	 * SELECT with an untyped expression, where derivation is all-or-nothing —
	 * and when the two agree. Only field *names* are compared: a declared schema
	 * narrowing a column's type is the legitimate use, not drift.
	 */
	readonly rowSchemaMismatch: RowSchemaMismatch | undefined
	/**
	 * Why this query is handwritten SQL, when it is — set only by
	 * {@link rawCompiledQuery}, absent for a query the builder produced.
	 *
	 * On the compiled query rather than only at the call site, because that is
	 * what makes the reason auditable: a catalog sweep can count the handwritten
	 * queries and group them by reason, and an executor can log which one it is
	 * about to run. A required argument that nothing stores is a gate only a
	 * human reviewer can see.
	 */
	readonly rawSql?: { readonly reason: string; readonly justification: string }
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
	/**
	 * The row codec itself, when the query has one.
	 *
	 * `decodeRows` / `encodeRows` are the two directions as functions; this is
	 * the thing they are built from, for the callers that need a `Schema` rather
	 * than a call — a cache that round-trips values through JSON, a boundary that
	 * composes it into a larger schema. Without it those callers have to
	 * re-declare by hand the shape the builder already knows.
	 */
	readonly rowSchema: CompiledQueryRowSchema<Output> | undefined
	/**
	 * The other direction: decoded rows back to the wire shape ClickHouse sent.
	 *
	 * The row schema is a codec, so it runs backwards for free — and running it
	 * backwards is what lets a surface hold the *good* value in memory and still
	 * emit the byte-for-byte shape its own clients parse. A `DateTime` column
	 * decoded to a `DateTime.Utc` re-encodes to `'YYYY-MM-DD hh:mm:ss'`, not to
	 * ISO-8601, because that is what the column's codec says the wire form is.
	 *
	 * Without this, keeping a wire byte-stable means never parsing it — which is
	 * what `T.dateTimeString` is for, and why it exists. A query whose row schema
	 * is `"none"` has no codec to reverse, so this returns the rows unchanged —
	 * the same contract `decodeRows` has.
	 */
	// Method syntax, not a property with a function type, and deliberately:
	// `Output` in a parameter position would make `CompiledQuery<Output>`
	// invariant, and a builder that returns one of two row shapes for the same
	// logical query — the usage query and its compare variant — could no longer
	// be assigned to the wider of them. Method parameters stay bivariant.
	encodeRows(
		rows: ReadonlyArray<Output>,
	): Effect.Effect<ReadonlyArray<Record<string, unknown>>, CompiledQueryEncodeError>
}

/**
 * Route is a type-level fact as well as runtime metadata, so a query tagged
 * for one backend cannot be passed accidentally to an API that reads from
 * another.
 */
export type CompiledQuery<
	Output,
	Route extends string | undefined = string | undefined,
> = CompiledQueryBase<Output> &
	(Route extends string ? { readonly route: Route } : { readonly route?: undefined })

/**
 * A query's row codec.
 *
 * Pinned to a service-free codec, not left as `Schema.Schema<Output>`: rows
 * arrive from a socket with nothing to provide, so a schema that needs a
 * service to decode could never run here. Saying so is what lets `decodeRows`
 * and `encodeRows` build their decoders without casting the services away —
 * the cost is that a caller assembling one out of generic `Schema.Struct.Fields`
 * has to carry the same constraint on its own type parameter.
 */
export type CompiledQueryRowSchema<Output> = Schema.Codec<Output, any, never, never>

/**
 * A compiled query, or the unrun compile that produces one.
 *
 * `compile` reports in the Effect channel, so an executor accepting this in
 * place of a `CompiledQuery` becomes the single place that decides what a
 * `QueryBuilderError` means — instead of every call site deciding again on the
 * way in, which is how a codebase ends up with one `Effect.orDie` per query.
 */
export type CompiledQueryInput<Output, Routing extends string | undefined = string | undefined> =
	| CompiledQuery<Output, Routing>
	| Effect.Effect<CompiledQuery<Output, Routing>, QueryBuilderError>

/**
 * A declared row schema's field names against the ones the SELECT emits.
 *
 * Both directions matter and they fail differently: an `undeclared` column is a
 * value the query produces and nothing validates, while an `unselected` field
 * is one the declared schema insists on and the query cannot supply — the
 * second decodes as a hard `ParseError` the first time it runs.
 */
export interface RowSchemaMismatch {
	/** Selected aliases the declared schema does not describe. */
	readonly undeclared: ReadonlyArray<string>
	/** Declared fields the SELECT does not emit. */
	readonly unselected: ReadonlyArray<string>
}

/** The field names of a struct codec, or `undefined` if it is not one. */
const structFieldNames = (schema: unknown): ReadonlyArray<string> | undefined => {
	const ast = (schema as { readonly ast?: { readonly _tag?: string } } | undefined)?.ast
	if (ast?._tag !== "Objects") return undefined
	const signatures = (
		ast as { readonly propertySignatures?: ReadonlyArray<{ readonly name: PropertyKey }> }
	).propertySignatures
	return signatures?.map((signature) => String(signature.name))
}

/**
 * Compare a declared schema against the derived one by field name.
 *
 * Silent — `undefined` — unless both are structs and the names differ. A
 * declared schema that is not a struct (a codec wrapping one, a union) has no
 * field list to read, and inventing a complaint from that would make the gate
 * built on this untrustworthy.
 */
const compareRowSchemas = (declared: unknown, derived: unknown): RowSchemaMismatch | undefined => {
	const declaredNames = structFieldNames(declared)
	const derivedNames = structFieldNames(derived)
	if (declaredNames === undefined || derivedNames === undefined) return undefined

	const declaredSet = new Set(declaredNames)
	const derivedSet = new Set(derivedNames)
	const undeclared = derivedNames.filter((name) => !declaredSet.has(name))
	const unselected = declaredNames.filter((name) => !derivedSet.has(name))
	return undeclared.length === 0 && unselected.length === 0 ? undefined : { undeclared, unselected }
}

const makeCompiledQuery = <Output, Route extends string | undefined>(
	sql: string,
	tenantScope: TenantScope,
	rowSchemaSource: "declared" | "derived" | "none",
	/** Built on first decode: a derived schema costs a `Schema.Struct` per
	 *  compile otherwise, and most compiled queries are never decoded. */
	getRowSchema: (() => CompiledQueryRowSchema<Output> | undefined) | undefined,
	route?: Route,
	untypedColumns: ReadonlyArray<string> = [],
	rawSql?: { readonly reason: string; readonly justification: string },
	rowSchemaMismatch?: RowSchemaMismatch,
): CompiledQuery<Output, Route> => {
	let cachedDecodeRow: ((row: unknown) => Effect.Effect<Output, unknown, never>) | undefined
	let decoderBuilt = false
	const decodeRow = () => {
		if (!decoderBuilt) {
			decoderBuilt = true
			const rowSchema = getRowSchema?.()
			cachedDecodeRow = rowSchema ? Schema.decodeUnknownEffect(rowSchema) : undefined
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

	let cachedEncodeRow: ((row: Output) => Effect.Effect<unknown, unknown, never>) | undefined
	let encoderBuilt = false
	const encodeRow = () => {
		if (!encoderBuilt) {
			encoderBuilt = true
			const rowSchema = getRowSchema?.()
			cachedEncodeRow = rowSchema ? Schema.encodeUnknownEffect(rowSchema) : undefined
		}
		return cachedEncodeRow
	}

	const encodeRows: CompiledQueryBase<Output>["encodeRows"] = (rows) => {
		const encode = encodeRow()
		if (!encode) return Effect.succeed(rows as ReadonlyArray<Record<string, unknown>>)

		return Effect.forEach(rows, (row, index) =>
			encode(row).pipe(
				Effect.mapError(
					(cause) =>
						new CompiledQueryEncodeError({
							message: `Compiled query row ${index} could not be encoded to its wire shape`,
							rowIndex: index,
							cause,
						}),
				),
			),
		).pipe(Effect.map((encoded) => encoded as ReadonlyArray<Record<string, unknown>>))
	}

	return {
		sql,
		tenantScope,
		// Resolved eagerly only here, where the getter is already memoised by
		// `decodeRow`/`encodeRow` below; reading it does not build a second one.
		get rowSchema() {
			return getRowSchema?.()
		},
		rowSchemaSource,
		untypedColumns: rowSchemaSource === "none" ? untypedColumns : [],
		rowSchemaMismatch,
		...(rawSql !== undefined ? { rawSql } : undefined),
		...(!(route === undefined) ? { route } : undefined),
		decodeRows,
		encodeRows,
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
	} as CompiledQuery<Output, Route>
}

/**
 * Explicit constructor for SQL that cannot be expressed through the typed DSL.
 *
 * Prefer `compile(CH.from(...))`. `tenantScope` here is taken at face value —
 * there is no query AST to inspect, only a string — which is exactly why this
 * is the one place tenant scope can be *asserted* rather than derived, and why
 * every use has to name a `reason` and say why in a `justification`.
 *
 * DDL, migrations, and another engine's file formats don't reach this function
 * at all; they never produce a `CompiledQuery`.
 */
export const rawCompiledQuery = <
	Output,
	Route extends string | undefined = undefined,
	Reason extends string = string,
>(args: {
	readonly sql: string
	readonly tenantScope: TenantScope
	readonly reason: Reason
	/** One sentence, at the call site, on why this instance qualifies. */
	readonly justification: string
	readonly rowSchema?: CompiledQueryRowSchema<Output>
	readonly route?: Route
}): CompiledQuery<Output, Route> =>
	makeCompiledQuery(
		args.sql,
		args.tenantScope,
		args.rowSchema === undefined ? "none" : "declared",
		() => args.rowSchema,
		args.route,
		[],
		{ reason: args.reason, justification: args.justification },
	)

/**
 * A thrown `QueryBuilderError` as a typed failure.
 *
 * Compilation reads values it cannot check earlier — the params bag, whatever a
 * caller compared a column against — so a missing param or an unencodable value
 * is an expected failure, not a bug. Anything else that escapes is a bug and
 * stays a defect: catching it would turn a real crash into a value someone
 * pattern-matches on.
 */
interface UnexpectedCompileFailure {
	readonly _tag: "UnexpectedCompileFailure"
	readonly cause: unknown
}

const asEffect = <A>(compile: () => A): Effect.Effect<A, QueryBuilderError> =>
	Effect.try({
		try: compile,
		catch: (cause): QueryBuilderError | UnexpectedCompileFailure =>
			cause instanceof QueryBuilderError ? cause : { _tag: "UnexpectedCompileFailure" as const, cause },
		// `UnexpectedCompileFailure` is this builder's own "cannot happen" tag: a query
		// is built from typed definitions, so a compile that throws is a bug in this
		// file rather than a failure a call site could handle.
		// oxlint-disable-next-line maple/no-effect-die
	}).pipe(Effect.catchTag("UnexpectedCompileFailure", ({ cause }) => Effect.die(cause)))

/**
 * Compile a query, with failures in the error channel.
 *
 * The compile step used to throw. `QueryBuilderError` was already a
 * `Schema.TaggedError`, but a thrown one is a defect: a route could not
 * `catchTag` it, and a missing param reached production as an unhandled crash
 * rather than a typed 400. Use {@link compileCHUnsafe} where a throw is what you
 * want — a fixture that fails to compile should fail its test loudly.
 */
export const compileCH = <
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
	Joins extends Record<string, ColumnDefs>,
	Route extends string | undefined,
	Params extends Record<string, any>,
	Decoded extends Output = Output,
>(
	query: CHQuery<Cols, Output, Joins, Route>,
	params: Params,
	options?: {
		skipFormat?: boolean
		rowSchema?: CompiledQueryRowSchema<Decoded>
		deferParams?: boolean
	},
): Effect.Effect<CompiledQuery<Decoded, Route>, QueryBuilderError> =>
	asEffect(() => compileCHUnsafe(query, params, options))

/** {@link compileCH} for a `UNION ALL`. */
export const compileUnion = <Output extends Record<string, any>, Params extends Record<string, any>>(
	union: CHUnionQuery<Output>,
	params: Params,
	options?: { rowSchema?: CompiledQueryRowSchema<Output>; deferParams?: boolean },
): Effect.Effect<CompiledQuery<Output, undefined>, QueryBuilderError> =>
	asEffect(() => compileUnionUnsafe(union, params, options))

export function compileCHUnsafe<
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
	Joins extends Record<string, ColumnDefs>,
	Route extends string | undefined,
	Params extends Record<string, any>,
	Decoded extends Output = Output,
>(
	query: CHQuery<Cols, Output, Joins, Route>,
	params: Params,
	options?: {
		skipFormat?: boolean
		rowSchema?: CompiledQueryRowSchema<Decoded>
		/** Leave `__PARAM_…__` placeholders in the SQL instead of resolving them.
		 *  For fragments spliced into a larger query — a subquery condition — whose
		 *  params are resolved by the outer compilation pass. */
		deferParams?: boolean
	},
): CompiledQuery<Decoded, Route> {
	return compileInner(query, params, options)
}

/**
 * The recursion behind {@link compileCHUnsafe}.
 *
 * Separate only so `enclosingCtes` — which `compile` sets for itself as it walks
 * a query's CTEs, and which no caller has any reason to pass — stays off the
 * published signature, along with the `ResolvedCte` shape it names.
 */
function compileInner<
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
	Joins extends Record<string, ColumnDefs>,
	Route extends string | undefined,
	Params extends Record<string, any>,
	// The row schema, not the SELECT inference, is what actually produces values
	// at runtime, so it decides the compiled query's output type. `extends Output`
	// keeps it honest: a schema may *narrow* what the builder inferred (a String
	// column decoded as a literal union) but never contradict it.
	Decoded extends Output = Output,
>(
	query: CHQuery<Cols, Output, Joins, Route>,
	params: Params,
	options?: {
		skipFormat?: boolean
		rowSchema?: CompiledQueryRowSchema<Decoded>
		/** Leave `__PARAM_…__` placeholders in the SQL instead of resolving them.
		 *  For fragments spliced into a larger query — a subquery condition — whose
		 *  params are resolved by the outer compilation pass. */
		deferParams?: boolean
		/**
		 * The tenant scopes of CTEs an enclosing query has already resolved.
		 *
		 * Set by `compile` itself as it walks a query's own CTEs, so a CTE that
		 * reads an earlier sibling — the usual `WITH a AS (…), b AS (SELECT … FROM a)`
		 * chain — inherits that sibling's scope instead of reading as
		 * `"cross-tenant"` because it names a table this compilation cannot see.
		 * A CTE's own FROM-subquery or join is not threaded, so one reaching a
		 * sibling from there still derives `"cross-tenant"` — the safe direction,
		 * and the reason this is a scope hint rather than a resolver.
		 * There is no reason to pass it by hand.
		 */
		enclosingCtes?: ReadonlyArray<ResolvedCte>
	},
): CompiledQuery<Decoded, Route> {
	const state = query._state
	const deferParams = options?.deferParams === true

	// The one accessor factory — shared with `selectExprsOf`, which reads a
	// query's output schemas without compiling it. Building a second one here is
	// what silently dropped every joined and subquery column's type: this path
	// passed `state.columns` (empty for a `fromQuery`/`fromUnion`) and no join
	// columns at all, so `$.p.ServiceName` and `$.bucket` compiled to correct SQL
	// with no schema, and the query derived nothing.
	const $ = makeAccessor(state)

	// SELECT
	const selectExprs = state.selectFn ? state.selectFn($) : {}
	const selectFragments = Object.entries(selectExprs).map(([alias, expr]) => aliased(expr, alias))

	if (selectFragments.length === 0) {
		throw new QueryBuilderDefect({ message: "CHQuery: select() is required" })
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
	// Sequential, not `map`: each CTE is compiled with the ones before it in
	// scope, which is the only way `WITH a AS (…), b AS (SELECT … FROM a)` can
	// see that `b` reads a tenant-confined source.
	const resolvedCtes: Array<ResolvedCte> = []
	for (const c of state.ctes) {
		if (c.query) {
			const compiled = compileInner(c.query, params, {
				skipFormat: true,
				deferParams,
				enclosingCtes: [...(options?.enclosingCtes ?? []), ...resolvedCtes],
			})
			resolvedCtes.push({ name: c.name, sql: compiled.sql, tenantScope: compiled.tenantScope })
		} else {
			resolvedCtes.push({ name: c.name, sql: c.sql ?? "", tenantScope: c.tenantScope })
		}
	}

	// FROM clause
	let fromFragment
	// Whether the row source is itself tenant-confined. A query reading only from
	// a scoped subquery cannot see another tenant's rows even with no WHERE of
	// its own — that is the `SELECT sum(total) FROM (scoped UNION scoped)` shape.
	let fromSourceScope: TenantScope = "untenanted"
	if (state.fromQuery) {
		// Compile the inner query lazily
		const innerCompiled = compileInner(state.fromQuery, params, { skipFormat: true, deferParams })
		fromSourceScope = innerCompiled.tenantScope
		fromFragment = raw(`(${innerCompiled.sql}) AS ${state.fromQueryAlias}`)
	} else if (state.fromUnion) {
		// Compile the inner union without an outer FORMAT — the outer query
		// owns formatting. Strips a trailing `\nFORMAT <fmt>` defensively.
		const innerCompiled = compileUnionUnsafe(state.fromUnion, params, { deferParams })
		fromSourceScope = innerCompiled.tenantScope
		const innerSql = splitTerminalClauses(innerCompiled.sql).body
		fromFragment = raw(`(\n${innerSql}\n) AS ${state.fromQueryAlias}`)
	} else if (state.tableAlias) {
		fromFragment = raw(`${state.tableName} AS ${state.tableAlias}`)
	} else {
		fromFragment = ident(state.tableName)
	}

	// Whether any source this query reads MIGHT carry row-level tenancy. Only a
	// query where the builder can see every source and none declares a tenant
	// column is `"untenanted"`; anything it cannot see into — a CTE handed to it
	// as a SQL string, a subquery over a tenanted table — counts as tenanted, so
	// the unknown case stays `"cross-tenant"` and keeps being refused.
	let anySourceMayBeTenanted = state.tenantColumn !== undefined

	// A FROM that names a CTE inherits the CTE's scope — derived when the CTE was
	// given as a query, declared by the caller when it arrived as a string.
	//
	// This query's OWN CTEs are searched first, because that is how SQL scopes
	// them: an inner `WITH x AS (…)` shadows an enclosing one of the same name,
	// verified against a server (`WITH x AS (SELECT 1), y AS (WITH x AS (SELECT 2)
	// SELECT v FROM x) SELECT v FROM y` returns 2). Searching the enclosing list
	// first read the scope off a CTE the query does not execute — and in the
	// direction that matters, since it could certify a scan of every tenant as
	// `"single-tenant"`.
	if (!state.fromQuery && !state.fromUnion) {
		const cte = [...resolvedCtes, ...(options?.enclosingCtes ?? [])].find(
			(c) => c.name === state.tableName,
		)
		if (cte !== undefined && cte.tenantScope !== "untenanted") anySourceMayBeTenanted = true
		if (cte?.tenantScope === "single-tenant") fromSourceScope = "single-tenant"
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
					if (j.tenantColumn !== undefined) anySourceMayBeTenanted = true
					if (j.innerQuery) {
						const compiled = compileInner(j.innerQuery, params, {
							skipFormat: true,
							deferParams,
						})
						if (compiled.tenantScope !== "untenanted") anySourceMayBeTenanted = true
						if (compiled.tenantScope !== "single-tenant") allJoinSourcesScoped = false
						tableSql = `(${compiled.sql})`
					} else if (j.tableName) {
						if (j.columns === undefined) anySourceMayBeTenanted = true
						allJoinSourcesScoped = false
						tableSql = j.tableName
					} else {
						throw new QueryBuilderDefect({ message: "TypedJoin: missing table or query" })
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
	// A FROM-subquery or union that is itself untenanted contributes no tenancy;
	// one that is scoped or unscoped does, because it read a table that declares
	// a tenant column.
	if ((state.fromQuery || state.fromUnion) && fromSourceScope !== "untenanted") {
		anySourceMayBeTenanted = true
	}

	const tenantScope: TenantScope =
		state.crossTenant === true
			? "cross-tenant"
			: hasOwnTenantPredicate || (fromSourceScope === "single-tenant" && allJoinSourcesScoped)
				? "single-tenant"
				: anySourceMayBeTenanted
					? "cross-tenant"
					: "untenanted"

	const derived = deriveRowSchema(selectExprs)
	const derivedSchema = "schema" in derived ? derived.schema : undefined

	return makeCompiledQuery<Decoded, Route>(
		sql,
		tenantScope,
		options?.rowSchema !== undefined ? "declared" : derivedSchema ? "derived" : "none",
		() => options?.rowSchema ?? (derivedSchema as CompiledQueryRowSchema<Decoded> | undefined),
		state.routeValue as Route,
		"untyped" in derived ? derived.untyped : [],
		undefined,
		options?.rowSchema === undefined ? undefined : compareRowSchemas(options.rowSchema, derivedSchema),
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
		Object.fromEntries(state.typedJoins.map((j) => [j.alias, joinColumnsOf(j)])),
	)
}

/**
 * A join's columns: its table's, or — for a joined subquery — the schemas of
 * the SELECT it will compile to.
 *
 * `innerJoinQuery` records no columns (there is no table to read them from), so
 * without this every `$.alias.field` off a joined subquery is untyped.
 */
function joinColumnsOf(join: {
	readonly columns?: ColumnDefs
	readonly innerQuery?: CHQuery<any, any, any>
}): ColumnDefs | undefined {
	if (join.columns !== undefined) return join.columns
	if (join.innerQuery === undefined) return undefined
	const exprs = selectExprsOf(join.innerQuery)
	return exprs === undefined ? undefined : synthesizeColumns(exprs)
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

	return synthesizeColumns(innerExprs)
}

/**
 * Column definitions for a derived source, from the expressions its SELECT
 * produced. An expression with no schema of its own contributes no column, so
 * the outer query's reference to it stays untyped rather than being invented.
 */
function synthesizeColumns(exprs: Record<string, unknown>): ColumnDefs {
	const synthesized: Record<string, CHType<"Inferred", any, any>> = {}
	for (const [alias, expr] of Object.entries(exprs)) {
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
const deriveRowSchema = (
	selectExprs: Record<string, unknown>,
): { readonly schema: Schema.Codec<any, any> } | { readonly untyped: ReadonlyArray<string> } => {
	const fields: Record<string, Schema.Codec<any, any>> = {}
	const untyped: Array<string> = []
	for (const [alias, expr] of Object.entries(selectExprs)) {
		const schema = (expr as { readonly schema?: Schema.Codec<any, any> } | null)?.schema
		if (schema === undefined) untyped.push(alias)
		else fields[alias] = schema
	}
	// Every alias is collected before returning, rather than bailing at the
	// first: naming one column at a time turns a ten-column fix into ten
	// compile-and-look cycles.
	return untyped.length > 0 ? { untyped } : { schema: Schema.Struct(fields) }
}

/**
 * Fold every branch's SELECT into one row schema, widening per column.
 *
 * All-or-nothing like the single-query case: one branch that cannot describe a
 * column means the union cannot either. Identical schemas collapse rather than
 * becoming a one-member union, so the common case — every branch selecting the
 * same column type — costs nothing.
 */
const deriveUnionRowSchema = (
	branches: ReadonlyArray<CHQuery<any, any, any>>,
): { readonly schema: Schema.Codec<any, any> } | { readonly untyped: ReadonlyArray<string> } | undefined => {
	if (branches.length === 0) return undefined

	const perColumn = new Map<string, Array<Schema.Codec<any, any>>>()
	const untyped = new Set<string>()
	for (const branch of branches) {
		const exprs = selectExprsOf(branch)
		if (exprs === undefined) return undefined
		for (const [alias, expr] of Object.entries(exprs)) {
			const schema = (expr as { readonly schema?: Schema.Codec<any, any> } | null)?.schema
			if (schema === undefined) {
				untyped.add(alias)
				continue
			}
			const seen = perColumn.get(alias) ?? []
			if (!seen.includes(schema)) seen.push(schema)
			perColumn.set(alias, seen)
		}
	}
	if (untyped.size > 0) return { untyped: [...untyped] }

	const fields: Record<string, Schema.Codec<any, any>> = {}
	for (const [alias, schemas] of perColumn) {
		const only = schemas.length === 1 ? schemas[0] : undefined
		fields[alias] = only ?? Schema.Union(schemas)
	}
	return { schema: Schema.Struct(fields) }
}

// UNION ALL compilation

export function compileUnionUnsafe<Output extends Record<string, any>, Params extends Record<string, any>>(
	union: CHUnionQuery<Output>,
	params: Params,
	options?: { rowSchema?: CompiledQueryRowSchema<Output>; deferParams?: boolean },
): CompiledQuery<Output, undefined> {
	const state = union._state
	const deferParams = options?.deferParams === true

	// Compile each sub-query without FORMAT
	const subQueries = state.queries.map((q) => compileInner(q, params, { skipFormat: true, deferParams }))

	// UNION ALL is a disjunction: one unscoped branch leaks every tenant into the
	// result regardless of how tightly the others are filtered.
	const tenantScope: TenantScope =
		subQueries.length > 0 && subQueries.every((q) => q.tenantScope === "single-tenant")
			? "single-tenant"
			: // All-untenanted branches read nothing tenanted, so the union does not
				// either. Any other mix has at least one branch that spans tenants.
				subQueries.length > 0 && subQueries.every((q) => q.tenantScope === "untenanted")
				? "untenanted"
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

	// A union decodes as its branches do — but not as its FIRST branch does.
	// The branches share an Output *shape*, not a column type: ClickHouse widens
	// across them, so a column that is `String` in one branch and nullable in
	// another resolves to `Nullable(String)` for the whole union. Deriving from
	// branch 0 alone produced a schema that rejected rows the query can really
	// return.
	const derived = deriveUnionRowSchema(state.queries)
	const derivedSchema = derived && "schema" in derived ? derived.schema : undefined

	return makeCompiledQuery<Output, undefined>(
		sql,
		tenantScope,
		options?.rowSchema !== undefined ? "declared" : derivedSchema ? "derived" : "none",
		() => options?.rowSchema ?? (derivedSchema as CompiledQueryRowSchema<Output> | undefined),
		undefined,
		derived && "untyped" in derived ? derived.untyped : [],
		undefined,
		options?.rowSchema === undefined ? undefined : compareRowSchemas(options.rowSchema, derivedSchema),
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

	// Nothing placeholder-shaped may survive a resolved compile. The loop above
	// only reports the names it recognised, so a marker naming a kind the pattern
	// matches but `paramSchema` cannot resolve — or one a value smuggled past the
	// escaper — would otherwise reach the warehouse as query text.
	if (resolved.includes(PARAM_MARKER_PREFIX)) {
		throw new QueryBuilderError({
			code: "UnresolvedParam",
			message: "compile: unresolved param placeholder remains in the compiled SQL",
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
		// declared: `param.of` registers its type before it can reach any SQL —
		// which is why it is a defect and not a failure a caller could report.
		throw new QueryBuilderDefect({
			message: `compile: param '${name}' has an unknown type '${kind}'`,
		})
	}
	return encodeLiteral(schema, value, `param '${name}' (${kind})`)
}
