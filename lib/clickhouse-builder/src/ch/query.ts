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
//     .innerJoin(Events, "e", (main, e) => main.TraceId.eq(e.TraceId))
//     .select($ => ({
//       traceId: $.TraceId,
//       errorType: $.e.ErrorType,
//     }))

import type { ColumnDefs, CHType, InferTS, OutputToColumnDefs, NullableColumnDefs } from "./types"
import type { Table } from "./table"
import type { Expr, Condition, ColumnRef } from "./expr"
import { makeColumnRef } from "./expr"
import type { TenantScope } from "./compile"

// Type utilities

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

type OrderBySpec<Output> = [keyof Output & string, "asc" | "desc"]

/** Callback for ON conditions — receives main and joined column accessors. */
export type JoinOnCallback<MainCols extends ColumnDefs, JoinedCols extends ColumnDefs> = (
	main: ColumnAccessor<MainCols>,
	joined: ColumnAccessor<JoinedCols>,
) => Condition

// Query state (runtime storage)

interface TypedJoinClause {
	readonly type: "INNER" | "LEFT" | "CROSS"
	/** Table name for direct table joins. */
	readonly tableName?: string
	/** Inner query for subquery joins (compiled lazily at compileCH time). */
	readonly innerQuery?: CHQuery<any, any, any>
	readonly alias: string
	/** ON condition. Omitted for CROSS JOIN. */
	readonly on?: Condition
	/** The joined table's tenant column, if it declared one. */
	readonly tenantColumn?: string
	/** The joined table's column definitions, for decoding joined selections. */
	readonly columns?: ColumnDefs
}

export interface CHQueryState {
	readonly tableName: string
	readonly tableAlias?: string
	readonly columns: ColumnDefs
	readonly selectFn?: ($: any) => SelectRecord
	readonly whereFn?: ($: any) => Array<Condition | undefined>
	readonly groupByKeys: string[]
	/** Post-aggregation filter. Deliberately NOT consulted when deriving tenant
	 *  scope — see `having()` on the interface. */
	readonly havingFn?: ($: any) => Array<Condition | undefined>
	readonly orderBySpecs: Array<[string, "asc" | "desc"]>
	readonly limitValue?: number
	readonly offsetValue?: number
	readonly formatValue?: string
	/** Execution-route metadata carried onto the CompiledQuery (see compile.ts). */
	readonly routeValue?: string
	/** Set by `.crossTenant()`. Forces `tenantScope: "cross-tenant"` (see compile.ts). */
	readonly crossTenant?: boolean
	/** The FROM table's declared tenant column, if any. Propagated to the column
	 *  accessors so an `eq`/`in_` on it marks the query scoped. */
	readonly tenantColumn?: string
	/** Typed FROM subquery. Compiled lazily at compileCH time. */
	readonly fromQuery?: CHQuery<any, any, any>
	readonly fromQueryAlias?: string
	/** Typed FROM union (UNION ALL of branches with identical Output shape). */
	readonly fromUnion?: import("./union").CHUnionQuery<any>
	/** Typed joins (compiled lazily at compileCH time). */
	readonly typedJoins: TypedJoinClause[]
	/** CTE definitions prepended as WITH clauses. Either pre-compiled SQL with a
	 *  caller-asserted scope, or a query compiled lazily at compileCH time whose
	 *  scope is derived. */
	readonly ctes: Array<{
		name: string
		sql?: string
		query?: CHQuery<any, any, any>
		tenantScope?: TenantScope
	}>
}

// CHQuery interface

export interface CHQuery<
	Cols extends ColumnDefs = ColumnDefs,
	Output extends Record<string, any> = {},
	Joins extends Record<string, ColumnDefs> = {},
	Route extends string | undefined = string | undefined,
> {
	/** @internal — runtime query state */
	readonly _state: CHQueryState
	/** phantom */
	readonly _phantom?: { cols: Cols; output: Output; joins: Joins; route: Route }

	/** Select specific columns by name. Output keys match column names. */
	select<K extends keyof Cols & string>(
		...columns: K[]
	): CHQuery<Cols, { readonly [P in K]: InferTS<Cols[P]> }, Joins, Route>

	/** Select computed expressions via callback. */
	select<S extends SelectRecord>(
		fn: ($: JoinedColumnAccessor<Cols, Joins>) => S,
	): CHQuery<Cols, InferOutput<S>, Joins, Route>

	where(
		fn: ($: JoinedColumnAccessor<Cols, Joins>) => Array<Condition | undefined>,
	): CHQuery<Cols, Output, Joins, Route>

	groupBy(...keys: Array<keyof Output & string>): CHQuery<Cols, Output, Joins, Route>

	/**
	 * Post-aggregation filter, applied after `GROUP BY`.
	 *
	 * Output aliases are not on the column accessor, so reference them with
	 * `CH.dynamicColumn<T>("alias")`.
	 *
	 * A `HAVING` predicate on the tenant column does NOT make a query
	 * tenant-scoped: the rows are already aggregated by then, so the scan that
	 * produced them crossed tenants regardless. Scope comes only from the
	 * top-level `where` list.
	 */
	having(
		fn: ($: JoinedColumnAccessor<Cols, Joins>) => Array<Condition | undefined>,
	): CHQuery<Cols, Output, Joins, Route>

	orderBy(...specs: Array<OrderBySpec<Output>>): CHQuery<Cols, Output, Joins, Route>

	limit(n: number): CHQuery<Cols, Output, Joins, Route>

	offset(n: number): CHQuery<Cols, Output, Joins, Route>

	format(fmt: "JSON" | "JSONEachRow"): CHQuery<Cols, Output, Joins, Route>

	/**
	 * Tag this query with an execution route, carried through to the compiled
	 * query as a type-level fact. The tag is opaque to the builder: what routes
	 * exist, and what an executor does with one, is the caller's vocabulary.
	 */
	route<Route extends string>(route: Route): CHQuery<Cols, Output, Joins, Route>

	/**
	 * Declare that this query deliberately reads across every tenant, forcing
	 * `tenantScope: "cross-tenant"` on the compiled result.
	 *
	 * Opting in explicitly rather than relying on the absence of a tenant
	 * predicate is the whole point: "no tenant filter" is indistinguishable from
	 * "someone forgot the tenant filter" until an author says which. Executors
	 * are expected to refuse these on the ordinary read path.
	 */
	crossTenant(): CHQuery<Cols, Output, Joins, Route>

	// Type-safe joins with Table

	innerJoin<JName extends string, JCols extends ColumnDefs, Alias extends string>(
		table: Table<JName, JCols>,
		alias: Alias,
		on: JoinOnCallback<Cols, JCols>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: JCols }, Route>

	leftJoin<JName extends string, JCols extends ColumnDefs, Alias extends string>(
		table: Table<JName, JCols>,
		alias: Alias,
		on: JoinOnCallback<Cols, JCols>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: NullableColumnDefs<JCols> }, Route>

	crossJoin<JName extends string, JCols extends ColumnDefs, Alias extends string>(
		table: Table<JName, JCols>,
		alias: Alias,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: JCols }, Route>

	// Type-safe joins with subquery (CHQuery)

	innerJoinQuery<
		JCols extends ColumnDefs,
		JOutput extends Record<string, any>,
		JJoins extends Record<string, ColumnDefs>,
		Alias extends string,
	>(
		query: CHQuery<JCols, JOutput, JJoins>,
		alias: Alias,
		on: JoinOnCallback<Cols, OutputToColumnDefs<JOutput>>,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: OutputToColumnDefs<JOutput> }, Route>

	leftJoinQuery<
		JCols extends ColumnDefs,
		JOutput extends Record<string, any>,
		JJoins extends Record<string, ColumnDefs>,
		Alias extends string,
	>(
		query: CHQuery<JCols, JOutput, JJoins>,
		alias: Alias,
		on: JoinOnCallback<Cols, OutputToColumnDefs<JOutput>>,
	): CHQuery<
		Cols,
		Output,
		Joins & { readonly [K in Alias]: NullableColumnDefs<OutputToColumnDefs<JOutput>> },
		Route
	>

	crossJoinQuery<
		JCols extends ColumnDefs,
		JOutput extends Record<string, any>,
		JJoins extends Record<string, ColumnDefs>,
		Alias extends string,
	>(
		query: CHQuery<JCols, JOutput, JJoins>,
		alias: Alias,
	): CHQuery<Cols, Output, Joins & { readonly [K in Alias]: OutputToColumnDefs<JOutput> }, Route>

	/**
	 * Add a CTE (WITH clause). The CTE is prepended to the compiled query, and
	 * its name can then be used as a table name via `from()` or in raw
	 * expressions.
	 *
	 * Prefer this arm: the CTE is compiled at `compileCH` time and its tenant
	 * scope is *derived*, so a query whose only row source is a scoped CTE is
	 * itself scoped without anyone asserting it.
	 */
	withCTE(name: string, query: CHQuery<any, any, any>): CHQuery<Cols, Output, Joins, Route>

	/**
	 * Attach a CTE from pre-compiled SQL.
	 *
	 * `tenantScope` describes the SQL being passed in. It cannot be inferred —
	 * the CTE arrives as an opaque string — so a caller splicing in a query it
	 * compiled itself should pass the scope through, otherwise a query whose only
	 * row source is a scoped CTE reads as cross-tenant. Pass the query itself
	 * instead where you can, and this problem goes away.
	 */
	withCTE(
		name: string,
		sql: string,
		options?: { readonly tenantScope?: TenantScope },
	): CHQuery<Cols, Output, Joins, Route>
}

// Type utilities for extracting output types from queries

/**
 * Extract the Output type from a `CHQuery` or a `CHUnionQuery`.
 *
 * The union arm matters as much as the query arm: a builder returning
 * `CHUnionQuery<Row>` used to infer `never` here, which reads as "this query
 * has no output" rather than as the error it is, and quietly passed any
 * type-level assertion made about it.
 */
export type InferQueryOutput<Q> =
	Q extends CHQuery<any, infer O, any>
		? O
		: Q extends import("./union").CHUnionQuery<infer U extends Record<string, any>>
			? U
			: never

// ColumnAccessor factory (Proxy-based)

export function createColumnAccessor<Cols extends ColumnDefs>(
	columns: Cols,
	tenantColumn?: string,
): ColumnAccessor<Cols> {
	const cache = new Map<string, ColumnRef<string, CHType<string, any>>>()

	return new Proxy({} as ColumnAccessor<Cols>, {
		get(_target, prop) {
			if (typeof prop !== "string") return undefined
			let ref = cache.get(prop)
			if (!ref) {
				ref = makeColumnRef(prop, undefined, tenantColumn, columns[prop])
				cache.set(prop, ref)
			}
			return ref
		},
	})
}

// Qualified ColumnAccessor for joined tables (generates alias.Column SQL)

function createQualifiedColumnAccessor(
	alias: string,
	tenantColumn?: string,
	columns?: ColumnDefs,
): ColumnAccessor<any> {
	const cache = new Map<string, ColumnRef<string, CHType<string, any>>>()

	return new Proxy({} as ColumnAccessor<any>, {
		get(_target, prop) {
			if (typeof prop !== "string") return undefined
			let ref = cache.get(prop)
			if (!ref) {
				ref = makeColumnRef(`${alias}.${prop}`, prop, tenantColumn, columns?.[prop])
				cache.set(prop, ref)
			}
			return ref
		},
	})
}

// Joined ColumnAccessor — main columns + nested alias accessors

export function createJoinedColumnAccessor<Cols extends ColumnDefs, Joins extends Record<string, ColumnDefs>>(
	columns: Cols,
	joinAliases: readonly string[],
	mainAlias?: string,
	/** The FROM table's tenant column. */
	tenantColumn?: string,
	/** Per-join-alias tenant columns, so `$.p.TenantId.eq(…)` scopes when the
	 *  joined table declares one of its own. */
	joinTenantColumns?: Readonly<Record<string, string | undefined>>,
	/** Per-join-alias column definitions, so joined refs decode like their own
	 *  table's columns rather than losing their schema at the alias boundary. */
	joinColumns?: Readonly<Record<string, ColumnDefs | undefined>>,
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
				cached = createQualifiedColumnAccessor(
					prop,
					joinTenantColumns?.[prop] ?? tenantColumn,
					joinColumns?.[prop],
				)
				cache.set(prop, cached)
				return cached
			}

			// Main table column — qualify with alias when joins are present
			const qualifiedName = mainAlias ? `${mainAlias}.${prop}` : prop
			cached = makeColumnRef(qualifiedName, prop, tenantColumn, columns[prop])
			cache.set(prop, cached)
			return cached
		},
	})
}

// Query builder implementation

function makeQuery<
	Cols extends ColumnDefs,
	Output extends Record<string, any>,
	Joins extends Record<string, ColumnDefs>,
	Route extends string | undefined,
>(state: CHQueryState): CHQuery<Cols, Output, Joins, Route> {
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

		having(fn) {
			return makeQuery({ ...state, havingFn: fn })
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

		route(route) {
			return makeQuery({ ...state, routeValue: route })
		},

		crossTenant() {
			return makeQuery({ ...state, crossTenant: true })
		},

		// Type-safe joins with Table

		innerJoin(table, alias, onFn) {
			const mainAlias = state.tableAlias ?? state.tableName
			const mainAccessor = createQualifiedColumnAccessor(mainAlias, state.tenantColumn, state.columns)
			const joinedAccessor = createQualifiedColumnAccessor(alias, table.tenantColumn, table.columns)
			const condition = onFn(mainAccessor, joinedAccessor)

			return makeQuery({
				...state,
				typedJoins: [
					...state.typedJoins,
					{
						type: "INNER",
						tableName: table.name,
						alias,
						on: condition,
						tenantColumn: table.tenantColumn,
						columns: table.columns,
					},
				],
			}) as any
		},

		leftJoin(table, alias, onFn) {
			const mainAlias = state.tableAlias ?? state.tableName
			const mainAccessor = createQualifiedColumnAccessor(mainAlias, state.tenantColumn, state.columns)
			const joinedAccessor = createQualifiedColumnAccessor(alias, table.tenantColumn, table.columns)
			const condition = onFn(mainAccessor, joinedAccessor)

			return makeQuery({
				...state,
				typedJoins: [
					...state.typedJoins,
					{
						type: "LEFT",
						tableName: table.name,
						alias,
						on: condition,
						tenantColumn: table.tenantColumn,
						columns: table.columns,
					},
				],
			}) as any
		},

		crossJoin(table, alias) {
			return makeQuery({
				...state,
				typedJoins: [
					...state.typedJoins,
					{
						type: "CROSS",
						tableName: table.name,
						alias,
						tenantColumn: table.tenantColumn,
						columns: table.columns,
					},
				],
			}) as any
		},

		// Type-safe joins with subquery (CHQuery)

		innerJoinQuery(query, alias, onFn) {
			const mainAlias = state.tableAlias ?? state.fromQueryAlias ?? state.tableName
			const mainAccessor = createQualifiedColumnAccessor(mainAlias, state.tenantColumn)
			const joinedAccessor = createQualifiedColumnAccessor(alias, state.tenantColumn)
			const condition = onFn(mainAccessor, joinedAccessor)

			return makeQuery({
				...state,
				typedJoins: [...state.typedJoins, { type: "INNER", innerQuery: query, alias, on: condition }],
			}) as any
		},

		leftJoinQuery(query, alias, onFn) {
			const mainAlias = state.tableAlias ?? state.fromQueryAlias ?? state.tableName
			const mainAccessor = createQualifiedColumnAccessor(mainAlias, state.tenantColumn)
			const joinedAccessor = createQualifiedColumnAccessor(alias, state.tenantColumn)
			const condition = onFn(mainAccessor, joinedAccessor)

			return makeQuery({
				...state,
				typedJoins: [...state.typedJoins, { type: "LEFT", innerQuery: query, alias, on: condition }],
			}) as any
		},

		crossJoinQuery(query, alias) {
			return makeQuery({
				...state,
				typedJoins: [...state.typedJoins, { type: "CROSS", innerQuery: query, alias }],
			}) as any
		},

		withCTE(
			name: string,
			sqlOrQuery: string | CHQuery<any, any, any>,
			options?: { tenantScope?: TenantScope },
		) {
			// The query arm is compiled lazily in compileCH (like `fromQuery`), so
			// its scope is derived there rather than taken from the caller.
			const cte =
				typeof sqlOrQuery === "string"
					? { name, sql: sqlOrQuery, tenantScope: options?.tenantScope }
					: { name, query: sqlOrQuery }
			return makeQuery({ ...state, ctes: [...state.ctes, cte] })
		},
	}
}

// Entry points

export function from<Name extends string, Cols extends ColumnDefs>(
	table: Table<Name, Cols>,
	alias?: string,
): CHQuery<Cols, {}, {}, undefined> {
	return makeQuery({
		tableName: table.name,
		tableAlias: alias,
		columns: table.columns,
		tenantColumn: table.tenantColumn,
		groupByKeys: [],
		orderBySpecs: [],
		typedJoins: [],
		ctes: [],
	})
}

/**
 * Start a query from another query's output (type-safe subquery in FROM).
 *
 * The alias names the derived table in SQL; it does NOT namespace the accessor.
 * Inner columns are reached flat (`$.traceId`) — `$.sub.traceId` is undefined
 * and throws when compiled.
 *
 * Usage:
 *   const inner = CH.from(Events).select($ => ({ id: $.Id }))
 *   const outer = CH.fromQuery(inner, "sub")
 *     .select($ => ({ id: $.id })) // fully typed!
 */
export function fromQuery<
	InnerCols extends ColumnDefs,
	InnerOutput extends Record<string, any>,
	InnerJoins extends Record<string, ColumnDefs>,
	Alias extends string,
>(
	query: CHQuery<InnerCols, InnerOutput, InnerJoins>,
	alias: Alias,
): CHQuery<OutputToColumnDefs<InnerOutput>, {}, {}, undefined> {
	return makeQuery({
		tableName: alias,
		columns: {},
		groupByKeys: [],
		orderBySpecs: [],
		typedJoins: [],
		ctes: [],
		// An outer re-filter on the same column name is still a tenant predicate;
		// if the inner SELECT renamed it, no such column exists to filter on.
		tenantColumn: query._state.tenantColumn,
		fromQuery: query,
		fromQueryAlias: alias,
	})
}

/**
 * Start a query from a UNION ALL of typed branches (type-safe subquery in
 * FROM). Use this when you need an outer aggregation/grouping over multiple
 * branches that share an Output shape — for example combining a sealed
 * hourly-MV branch with a live raw-table fallback for the in-progress hour,
 * then re-aggregating across the union.
 *
 * Usage:
 *   const branchA = CH.from(MvTable).select(...).where(...).groupBy(...)
 *   const branchB = CH.from(RawTable).select(...).where(...).groupBy(...)
 *   const combined = CH.unionAll(branchA, branchB)
 *   const outer = CH.fromUnion(combined, "edges")
 *     .select($ => ({ ..., total: CH.sum($.edges.partial) }))
 *     .groupBy("...")
 */
export function fromUnion<Output extends Record<string, any>, Alias extends string>(
	union: import("./union").CHUnionQuery<Output>,
	alias: Alias,
): CHQuery<OutputToColumnDefs<Output>, {}, {}, undefined> {
	return makeQuery({
		tableName: alias,
		columns: {},
		groupByKeys: [],
		orderBySpecs: [],
		typedJoins: [],
		ctes: [],
		fromUnion: union,
		fromQueryAlias: alias,
	})
}
