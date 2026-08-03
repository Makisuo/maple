// ---------------------------------------------------------------------------
// Expression System
//
// Typed expressions that compile to SqlFragment. Every Expr<T> carries a
// phantom TSType so TypeScript can infer output row types from SELECT clauses.
// ---------------------------------------------------------------------------

import type { SqlFragment } from "../sql/sql-fragment"
import { raw, str, compile, as_ as sqlAs } from "../sql/sql-fragment"
import type { CHType, InferTS } from "./types"

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

export interface Expr<TSType> {
	readonly _brand: "Expr"
	readonly _phantom?: TSType
	toFragment(): SqlFragment

	// Comparison — returns Condition
	eq(other: TSType | Expr<TSType>): Condition
	neq(other: TSType | Expr<TSType>): Condition
	gt(other: TSType | Expr<TSType>): Condition
	gte(other: TSType | Expr<TSType>): Condition
	lt(other: TSType | Expr<TSType>): Condition
	lte(other: TSType | Expr<TSType>): Condition

	// String operations
	like(this: Expr<string>, pattern: string): Condition
	notLike(this: Expr<string>, pattern: string): Condition
	ilike(this: Expr<string>, pattern: string): Condition

	// IN / NOT IN
	in_(...values: TSType[]): Condition
	notIn(...values: TSType[]): Condition

	// Arithmetic — only valid for number expressions
	div(this: Expr<number>, n: number | Expr<number>): Expr<number>
	mul(this: Expr<number>, n: number | Expr<number>): Expr<number>
	add(this: Expr<number>, n: number | Expr<number>): Expr<number>
	sub(this: Expr<number>, n: number | Expr<number>): Expr<number>
}

export interface ColumnRef<Name extends string, ColType extends CHType<string, any>> extends Expr<
	InferTS<ColType>
> {
	readonly columnName: Name
	/** Access a key in a Map column: `$.SpanAttributes.get("http.method")` */
	get(this: ColumnRef<Name, CHType<"Map", Record<string, string>>>, key: string): Expr<string>
}

export interface Condition {
	readonly _brand: "Condition"
	/**
	 * Set only by an equality/membership test on the tenant column
	 * (`TENANT_COLUMN`). `compile` reads it off the top-level `where` list to
	 * decide whether a query is tenant-scoped, so it deliberately does NOT
	 * propagate through `and`/`or`: `OrgId.eq(x).or(y)` is not a scoping
	 * predicate, and treating it as one is the bug this marker exists to catch.
	 */
	readonly scopesTenant?: boolean
	toFragment(): SqlFragment
	and(other: Condition): Condition
	or(other: Condition): Condition
}

// ---------------------------------------------------------------------------
// Core helpers (exported for define-fn.ts and consumer extensibility)
// ---------------------------------------------------------------------------

export function toFragment(value: unknown): SqlFragment {
	if (
		value != null &&
		typeof value === "object" &&
		"_brand" in value &&
		((value as { readonly _brand?: unknown })._brand === "Expr" ||
			(value as { readonly _brand?: unknown })._brand === "Condition") &&
		"toFragment" in value &&
		typeof (value as { readonly toFragment?: unknown }).toFragment === "function"
	) {
		return (value as Expr<unknown>).toFragment()
	}
	if (typeof value === "string") return str(value)
	if (typeof value === "number") return raw(String(value))
	if (typeof value === "boolean") return raw(value ? "1" : "0")
	return raw(String(value))
}

// ---------------------------------------------------------------------------
// Expr implementation
// ---------------------------------------------------------------------------

export function makeExpr<T>(fragment: SqlFragment): Expr<T> {
	const self: Expr<T> = {
		_brand: "Expr" as const,
		toFragment: () => fragment,

		eq: (other) => makeCond(raw(`${compile(fragment)} = ${compile(toFragment(other))}`)),
		neq: (other) => makeCond(raw(`${compile(fragment)} != ${compile(toFragment(other))}`)),
		gt: (other) => makeCond(raw(`${compile(fragment)} > ${compile(toFragment(other))}`)),
		gte: (other) => makeCond(raw(`${compile(fragment)} >= ${compile(toFragment(other))}`)),
		lt: (other) => makeCond(raw(`${compile(fragment)} < ${compile(toFragment(other))}`)),
		lte: (other) => makeCond(raw(`${compile(fragment)} <= ${compile(toFragment(other))}`)),

		like: (pattern: string) => makeCond(raw(`${compile(fragment)} LIKE ${compile(str(pattern))}`)),
		notLike: (pattern: string) => makeCond(raw(`${compile(fragment)} NOT LIKE ${compile(str(pattern))}`)),
		ilike: (pattern: string) => makeCond(raw(`${compile(fragment)} ILIKE ${compile(str(pattern))}`)),

		in_: (...values) => {
			const escaped = values.map((v) => compile(toFragment(v))).join(", ")
			return makeCond(raw(`${compile(fragment)} IN (${escaped})`))
		},
		notIn: (...values) => {
			const escaped = values.map((v) => compile(toFragment(v))).join(", ")
			return makeCond(raw(`${compile(fragment)} NOT IN (${escaped})`))
		},

		// NOTE: these do NOT parenthesize their result, so chaining follows SQL
		// operator precedence rather than call order — `a.sub(b).div(c)` compiles
		// to `a - b / c`, i.e. `a - (b / c)`. Order the calls so precedence works
		// in your favour, or bind an intermediate alias in a sub-query.
		div: (n: number | Expr<number>) =>
			makeExpr<number>(raw(`${compile(fragment)} / ${compile(toFragment(n))}`)),
		mul: (n: number | Expr<number>) =>
			makeExpr<number>(raw(`${compile(fragment)} * ${compile(toFragment(n))}`)),
		add: (n: number | Expr<number>) =>
			makeExpr<number>(raw(`${compile(fragment)} + ${compile(toFragment(n))}`)),
		sub: (n: number | Expr<number>) =>
			makeExpr<number>(raw(`${compile(fragment)} - ${compile(toFragment(n))}`)),
	}
	return self
}

// ---------------------------------------------------------------------------
// ColumnRef implementation
// ---------------------------------------------------------------------------

/**
 * The column carrying row-level tenancy. An equality or membership test on it
 * is what marks a query as tenant-scoped (`CompiledQuery.tenantScope`).
 *
 * Row-per-tenant is the usual ClickHouse multi-tenancy shape, but the column's
 * name is a schema decision — this is the single place to change it.
 */
export const TENANT_COLUMN = "OrgId"

export function makeColumnRef<Name extends string, ColType extends CHType<string, any>>(
	name: Name,
	/**
	 * Unqualified column name. Differs from `name` for joined accessors, where
	 * `name` is `alias.Column` — so `$.p.OrgId.eq(…)` still marks the query as
	 * scoped.  Defaults to `name` for the unqualified case.
	 */
	columnName?: string,
): ColumnRef<Name, ColType> {
	const fragment = raw(name)
	const base = makeExpr<InferTS<ColType>>(fragment)
	const isTenantColumn = (columnName ?? name) === TENANT_COLUMN
	// Captured before `Object.assign` mutates `base` — the overrides below reuse
	// these to emit byte-identical SQL, and reading them off `base` afterwards
	// would just call the override again.
	const baseEq = base.eq
	const baseIn = base.in_
	return Object.assign(
		base,
		// Only `eq`/`in_` scope a query. `neq`/`notIn`/`like` on the tenant column
		// narrow nothing, and marking them would let `OrgId != 'x'` pass as scoped.
		isTenantColumn
			? {
					eq: (other: any) => makeCond(baseEq(other).toFragment(), true),
					in_: (...values: ReadonlyArray<any>) =>
						makeCond((baseIn as any)(...values).toFragment(), true),
				}
			: {},
		{
			columnName: name as Name,
			get(key: string): Expr<string> {
				return makeExpr<string>(raw(`${name}[${compile(str(key))}]`))
			},
		},
	) as ColumnRef<Name, ColType>
}

// ---------------------------------------------------------------------------
// Condition implementation
// ---------------------------------------------------------------------------

export function makeCond(fragment: SqlFragment, scopesTenant?: boolean): Condition {
	return {
		_brand: "Condition" as const,
		...(scopesTenant === true ? { scopesTenant: true as const } : {}),
		toFragment: () => fragment,
		// Composition drops the marker on purpose — see `Condition.scopesTenant`.
		and: (other) => makeCond(raw(`(${compile(fragment)} AND ${compile(other.toFragment())})`)),
		or: (other) => makeCond(raw(`(${compile(fragment)} OR ${compile(other.toFragment())})`)),
	}
}

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

export function lit(value: string): Expr<string>
export function lit(value: number): Expr<number>
export function lit(value: string | number): Expr<string> | Expr<number> {
	if (typeof value === "string") return makeExpr<string>(str(value))
	return makeExpr<number>(raw(String(value)))
}

// ---------------------------------------------------------------------------
// Subquery expressions
// ---------------------------------------------------------------------------

/**
 * EXISTS (subquery) — for correlated subqueries.
 * The subquery must be compiled separately; this wraps its SQL as a condition.
 */
export function exists(subquerySql: string): Condition {
	return makeCond(raw(`EXISTS (${subquerySql})`))
}

/**
 * expr IN (subquery) — for uncorrelated subqueries.
 * The subquery must be compiled separately; this wraps its SQL as a condition.
 */
export function inSubquery<T>(expr: Expr<T>, subquerySql: string): Condition {
	return makeCond(raw(`${compile(expr.toFragment())} IN (${subquerySql})`))
}

/**
 * Reference an outer query's column in a correlated subquery.
 * Usage: `outerRef("t.TraceId")` or `outerRef("TraceId")`
 */
export function outerRef<T = string>(name: string): Expr<T> {
	return makeExpr<T>(raw(name))
}

export function inList(expr: Expr<string>, values: readonly string[]): Condition {
	const escaped = values.map((v) => compile(str(v))).join(", ")
	return makeCond(raw(`${compile(expr.toFragment())} IN (${escaped})`))
}

export function inExprList<T>(expr: Expr<T>, values: readonly Expr<T>[]): Condition {
	const escaped = values.map((v) => compile(v.toFragment())).join(", ")
	return makeCond(raw(`${compile(expr.toFragment())} IN (${escaped})`))
}

export function notInList(expr: Expr<string>, values: readonly string[]): Condition {
	const escaped = values.map((v) => compile(str(v))).join(", ")
	return makeCond(raw(`${compile(expr.toFragment())} NOT IN (${escaped})`))
}

/** Wrap a condition in NOT (...). */
export function not(condition: Condition): Condition {
	return makeCond(raw(`NOT (${compile(condition.toFragment())})`))
}

// ---------------------------------------------------------------------------
// Raw expression (escape hatch)
// ---------------------------------------------------------------------------

export function rawExpr<T = unknown>(sql: string): Expr<T> {
	return makeExpr<T>(raw(sql))
}

export function rawCond(sql: string): Condition {
	return makeCond(raw(sql))
}

/** Create an Expr from a runtime column name (for dynamic column access). */
export function dynamicColumn<T = string>(name: string): Expr<T> {
	return makeExpr<T>(raw(name))
}

// ---------------------------------------------------------------------------
// Aliased expression — used by query compilation
// ---------------------------------------------------------------------------

export function aliased<T>(expr: Expr<T>, alias: string): SqlFragment {
	return sqlAs(expr.toFragment(), alias)
}

// ---------------------------------------------------------------------------
// Conditional helpers (for optional WHERE clauses)
// ---------------------------------------------------------------------------

export function when<T>(value: T | undefined | false | null, fn: (v: T) => Condition): Condition | undefined {
	if (value === undefined || value === null || value === false) return undefined
	return fn(value)
}

export function whenTrue(value: boolean | undefined, fn: () => Condition): Condition | undefined {
	if (!value) return undefined
	return fn()
}

// ---------------------------------------------------------------------------
// Re-export all ClickHouse functions so `import * as CH from "./expr"` works
// ---------------------------------------------------------------------------

export {
	count,
	countIf,
	avg,
	sum,
	min_,
	max_,
	quantile,
	any_,
	anyIf,
	uniq,
	sumIf,
	avgIf,
	maxIf,
	minIf,
	groupUniqArray,
	argMaxMerge,
	toString_,
	positionCaseInsensitive,
	position_,
	left_,
	length_,
	lower_,
	replaceOne,
	extract_,
	concat,
	hasToken,
	hasAllTokens,
	round_,
	intDiv,
	toFloat64OrZero,
	toFloat64,
	toUInt16OrZero,
	toUInt64,
	toInt64,
	least_,
	greatest_,
	cityHash64,
	toStartOfInterval,
	toStartOfHour,
	toHour,
	toUnixTimestamp,
	toUnixTimestamp64Nano,
	intervalSub,
	formatDateTime,
	toDateTime,
	if_,
	multiIf,
	coalesce,
	nullIf,
	arrayOf,
	arrayStringConcat,
	arrayFilter,
	arrayJoin,
	has,
	mapContains,
	mapGet,
	mapKeys,
	mapValues,
	mapLiteral,
	toJSONString,
	currentRow,
	unboundedPreceding,
	unboundedFollowing,
	preceding,
	following,
	rowsBetween,
	windowSpec,
	over,
	lagInFrame,
} from "./functions"
