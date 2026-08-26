// BOUNDARY: This module owns unparsed values on their way into SQL — whatever a
// caller wrote on the right of a comparison — and narrows them, through the
// column's codec where there is one, before they reach a fragment.
// Expression System
//
// Typed expressions that compile to SqlFragment. Every Expr<T> carries a
// phantom TSType so TypeScript can infer output row types from SELECT clauses.

import { DateTime, Result, Schema } from "effect"
import type { SqlFragment } from "../sql/sql-fragment"
import { raw, str, compile, as_ as sqlAs } from "../sql/sql-fragment"
import { chDateTimeLiteral, CHNumber, string as chString, type CHType, type InferTS } from "./types"
import { encodeColumnLiteral } from "./literal"

// Core interfaces

/**
 * What a value of this type can be compared against in SQL.
 *
 * A `DateTime` column is a `DateTime.Utc` when it comes back, but writing a
 * bound as `'2026-01-01 00:00:00'` or a `Date` is how anyone actually writes
 * one — and all three serialize to the same literal.
 */
export type Comparable<TSType> = TSType extends DateTime.Utc ? DateTime.Utc | Date | string : TSType

export interface Expr<TSType> {
	readonly _brand: "Expr"
	readonly _phantom?: TSType
	/**
	 * How this expression's wire value decodes, when the builder knows it.
	 *
	 * Column refs take it from their table; function wrappers declare their own
	 * result type. `compile` folds the selected expressions' schemas into the
	 * row schema, so a query built entirely from typed pieces validates its rows
	 * without anyone writing a schema. Absent for `rawExpr`/`dynamicColumn`,
	 * where there is nothing to read it from.
	 */
	readonly schema?: Schema.Codec<TSType, any>
	toFragment(): SqlFragment

	// Comparison — returns Condition
	eq(other: Comparable<TSType> | Expr<TSType>): Condition
	neq(other: Comparable<TSType> | Expr<TSType>): Condition
	gt(other: Comparable<TSType> | Expr<TSType>): Condition
	gte(other: Comparable<TSType> | Expr<TSType>): Condition
	lt(other: Comparable<TSType> | Expr<TSType>): Condition
	lte(other: Comparable<TSType> | Expr<TSType>): Condition

	// String operations
	like(this: Expr<string>, pattern: string): Condition
	notLike(this: Expr<string>, pattern: string): Condition
	ilike(this: Expr<string>, pattern: string): Condition

	// IN / NOT IN
	in_(...values: Array<Comparable<TSType>>): Condition
	notIn(...values: Array<Comparable<TSType>>): Condition

	// Arithmetic — only valid for number expressions
	div(this: Expr<number>, n: number | Expr<number>): Expr<number>
	mul(this: Expr<number>, n: number | Expr<number>): Expr<number>
	add(this: Expr<number>, n: number | Expr<number>): Expr<number>
	sub(this: Expr<number>, n: number | Expr<number>): Expr<number>
	mod(this: Expr<number>, n: number | Expr<number>): Expr<number>
}

export interface ColumnRef<Name extends string, ColType extends CHType<string, any>> extends Expr<
	InferTS<ColType>
> {
	readonly columnName: Name
	/**
	 * Access a key in a Map column: `$.SpanAttributes.get("http.method")`.
	 *
	 * The result decodes as the map's *value* type, read off the column's
	 * `element`. A `Map(String, String)` subscript is an `Expr<string>` that
	 * knows it is one, so selecting it no longer costs the query its row schema.
	 */
	get(this: ColumnRef<Name, CHType<"Map", any, any>>, key: string): Expr<MapValueOf<ColType>>
}

/**
 * A Map column's value type, defaulting to `string`.
 *
 * Wrapped in tuples so an `any` column type — `ColumnRef<"Attrs", any>`, which
 * is how a helper shared across two tables usually types its accessor — takes
 * the `infer` branch and yields `any`, rather than distributing into `unknown`
 * and failing to assign anywhere.
 */
export type MapValueOf<ColType> = [ColType] extends [CHType<"Map", Record<string, infer V>, any>] ? V : string

export interface Condition {
	readonly _brand: "Condition"
	/**
	 * Set only by an equality/membership test on the table's declared tenant
	 * column (`table(name, cols, { tenantColumn })`). `compile` reads it off the
	 * top-level `where` list to decide whether a query is tenant-scoped, so it
	 * deliberately does NOT propagate through `and`/`or`: `TenantId.eq(x).or(y)`
	 * is not a scoping predicate, and treating it as one is the bug this marker
	 * exists to catch.
	 */
	readonly scopesTenant?: boolean
	toFragment(): SqlFragment
	and(other: Condition): Condition
	or(other: Condition): Condition
}

// Core helpers (exported for define-fn.ts and consumer extensibility)

/** An already-built expression or condition, rather than a value to encode. */
const isExprLike = (value: unknown): value is Expr<unknown> =>
	value != null &&
	typeof value === "object" &&
	"_brand" in value &&
	((value as { readonly _brand?: unknown })._brand === "Expr" ||
		(value as { readonly _brand?: unknown })._brand === "Condition") &&
	"toFragment" in value &&
	typeof (value as { readonly toFragment?: unknown }).toFragment === "function"

export function toFragment(value: unknown): SqlFragment {
	if (isExprLike(value)) return value.toFragment()
	if (typeof value === "string") return str(value)
	if (typeof value === "number") return raw(String(value))
	if (typeof value === "boolean") return raw(value ? "1" : "0")
	// A DateTime column compares against a DateTime value, so the literal has to
	// be ClickHouse's tz-less form rather than whatever `String(value)` produces.
	if (DateTime.isDateTime(value)) return str(chDateTimeLiteral(DateTime.toUtc(value)))
	if (value instanceof Date) return str(chDateTimeLiteral(DateTime.makeUnsafe(value)))
	return raw(String(value))
}

// Expr implementation

/** Whether a codec accepts `null` — asked, not inferred from its AST, so it
 *  stays right across Effect versions and across `T.custom` schemas. */
const acceptsNull = (schema: Schema.Codec<any, any> | undefined): boolean =>
	schema !== undefined && Result.isSuccess(Schema.decodeUnknownResult(schema)(null))

/**
 * `lhs <op> rhs` as a numeric expression — see the note on `div` below.
 *
 * A NULL operand makes the whole expression NULL in ClickHouse, so the result
 * decodes nullably when either side does. `CH.sum(x).div(CH.nullIf(CH.sum(y), 0))`
 * — the standard "average, or nothing when the denominator is zero" — is exactly
 * this shape, and a flat `CHNumber` here rejected the NULL it was written to
 * produce.
 *
 * Division and modulo decode nullably whatever their operands are, because they
 * can *manufacture* a NULL from two perfectly good numbers: `1/0` is `inf` and
 * `0/0` is `nan` in ClickHouse, and both render as JSON `null`. `CHNumber` is
 * `Schema.Finite`-based and would reject that null, so an unguarded division
 * that happens to hit a zero denominator in production fails to decode — a 500
 * for a query that ran fine. Nullable decoding costs nothing at the type level
 * (`Expr<number>` either way, as it already is for a nullable operand) and
 * turns that 500 into the `null` the wire actually carried. Reach for
 * {@link ifNotFinite} where a number, not a null, is what the caller needs.
 */
const arith = (
	lhs: SqlFragment,
	op: string,
	rhs: number | Expr<number>,
	lhsSchema?: Schema.Codec<any, any>,
): Expr<number> => {
	const rhsSchema = typeof rhs === "number" ? undefined : rhs.schema
	const nullable = op === "/" || op === "%" || acceptsNull(lhsSchema) || acceptsNull(rhsSchema)
	return makeExpr<number>(
		raw(`${compile(lhs)} ${op} ${compile(toFragment(rhs))}`),
		(nullable ? Schema.NullOr(CHNumber) : CHNumber) as Schema.Codec<number, any>,
	)
}

/**
 * An expression from a fragment and the codec its wire value decodes with.
 *
 * The schema is a required argument that accepts `undefined`, rather than an
 * optional one. Omitting it entirely was the last silent way to cost a query
 * its whole row schema — derivation is all-or-nothing, so one unschema'd field
 * makes the query decode nothing — and `undefined` is what a wrapper *forwards*
 * when its own argument was untyped (`schemaOf(arg)`), not what it means to
 * write. For an expression that genuinely has no type, use
 * {@link makeUntypedExpr}, which says so.
 */
export function makeExpr<T>(
	fragment: SqlFragment,
	schema: Schema.Codec<T, any> | undefined,
	/**
	 * How a plain value compared against this expression becomes a literal.
	 *
	 * Set for column refs, which know their own type: `$.Attrs.eq({ a: "b" })`
	 * then emits `map('a', 'b')` instead of `[object Object]`. Expressions with
	 * no type to read fall back to guessing from the JS value.
	 */
	literal?: (value: unknown) => SqlFragment,
): Expr<T> {
	/** An operand: another expression as-is, a plain value through the codec. */
	function operand(value: unknown): SqlFragment {
		return literal !== undefined && !isExprLike(value) ? literal(value) : toFragment(value)
	}

	const self: Expr<T> = {
		_brand: "Expr" as const,
		...(schema !== undefined ? { schema } : undefined),
		toFragment: () => fragment,

		eq: (other) => makeCond(raw(`${compile(fragment)} = ${compile(operand(other))}`)),
		neq: (other) => makeCond(raw(`${compile(fragment)} != ${compile(operand(other))}`)),
		gt: (other) => makeCond(raw(`${compile(fragment)} > ${compile(operand(other))}`)),
		gte: (other) => makeCond(raw(`${compile(fragment)} >= ${compile(operand(other))}`)),
		lt: (other) => makeCond(raw(`${compile(fragment)} < ${compile(operand(other))}`)),
		lte: (other) => makeCond(raw(`${compile(fragment)} <= ${compile(operand(other))}`)),

		like: (pattern: string) => makeCond(raw(`${compile(fragment)} LIKE ${compile(str(pattern))}`)),
		notLike: (pattern: string) => makeCond(raw(`${compile(fragment)} NOT LIKE ${compile(str(pattern))}`)),
		ilike: (pattern: string) => makeCond(raw(`${compile(fragment)} ILIKE ${compile(str(pattern))}`)),

		in_: (...values) => {
			const escaped = values.map((v) => compile(operand(v))).join(", ")
			return makeCond(raw(`${compile(fragment)} IN (${escaped})`))
		},
		notIn: (...values) => {
			const escaped = values.map((v) => compile(operand(v))).join(", ")
			return makeCond(raw(`${compile(fragment)} NOT IN (${escaped})`))
		},

		// NOTE: these do NOT parenthesize their result, so chaining follows SQL
		// operator precedence rather than call order — `a.sub(b).div(c)` compiles
		// to `a - b / c`, i.e. `a - (b / c)`. Order the calls so precedence works
		// in your favour, or bind an intermediate alias in a sub-query.
		//
		// The result is always `CHNumber` rather than the operand's own type:
		// ClickHouse promotes across the arithmetic operators (`UInt64 / UInt64`
		// is a Float64), and `CHNumber` is the one codec that reads every numeric
		// wire form either backend can send.
		div: (n: number | Expr<number>) => arith(fragment, "/", n, schema),
		mul: (n: number | Expr<number>) => arith(fragment, "*", n, schema),
		add: (n: number | Expr<number>) => arith(fragment, "+", n, schema),
		sub: (n: number | Expr<number>) => arith(fragment, "-", n, schema),
		mod: (n: number | Expr<number>) => arith(fragment, "%", n, schema),
	}
	return self
}

/**
 * An expression with no declared result type — {@link untypedExpr}'s
 * counterpart for a caller assembling its own fragment.
 *
 * Selecting one costs the whole query its derived row schema, which
 * `CompiledQuery.rowSchemaSource` reports as `"none"`. The legitimate use is a
 * value that never becomes a row.
 */
export function makeUntypedExpr<T = unknown>(
	fragment: SqlFragment,
	literal?: (value: unknown) => SqlFragment,
): Expr<T> {
	return makeExpr<T>(fragment, undefined, literal)
}

// ColumnRef implementation

export function makeColumnRef<Name extends string, ColType extends CHType<string, any>>(
	name: Name,
	/**
	 * Unqualified column name. Differs from `name` for joined accessors, where
	 * `name` is `alias.Column` — so `$.p.TenantId.eq(…)` still marks the query as
	 * scoped.  Defaults to `name` for the unqualified case.
	 */
	columnName?: string,
	/**
	 * The owning table's tenant column, if it declared one. An equality or
	 * membership test on that column is what marks a query as tenant-scoped
	 * (`CompiledQuery.tenantScope`). Row-per-tenant is the usual ClickHouse
	 * multi-tenancy shape, but whether a schema has one — and what it is called —
	 * is a schema decision, so it travels with the table rather than being a
	 * constant here.
	 */
	tenantColumn?: string,
	/** The column's declared type, whose schema decodes its wire value. */
	columnType?: ColType,
): ColumnRef<Name, ColType> {
	const fragment = raw(name)
	const base = makeExpr<InferTS<ColType>>(
		fragment,
		columnType?.schema as Schema.Codec<InferTS<ColType>, any> | undefined,
		columnType === undefined
			? undefined
			: (value) => raw(encodeColumnLiteral(columnType, value, columnName ?? name)),
	)
	const isTenantColumn = tenantColumn !== undefined && (columnName ?? name) === tenantColumn
	// Captured before `Object.assign` mutates `base` — the overrides below reuse
	// these to emit byte-identical SQL, and reading them off `base` afterwards
	// would just call the override again.
	const baseEq = base.eq
	const baseIn = base.in_
	return Object.assign(
		base,
		// Only `eq`/`in_` scope a query. `neq`/`notIn`/`like` on the tenant column
		// narrow nothing, and marking them would let `TenantId != 'x'` pass as scoped.
		isTenantColumn
			? {
					eq: (other: any) => makeCond(baseEq(other).toFragment(), true),
					in_: (...values: ReadonlyArray<any>) =>
						makeCond((baseIn as any)(...values).toFragment(), true),
				}
			: {},
		{
			columnName: name as Name,
			get(key: string): Expr<any> {
				return makeExpr<any>(raw(`${name}[${compile(str(key))}]`), columnType?.element?.schema)
			},
		},
	) as ColumnRef<Name, ColType>
}

// Condition implementation

export function makeCond(fragment: SqlFragment, scopesTenant?: boolean): Condition {
	return {
		_brand: "Condition" as const,
		...(scopesTenant === true ? { scopesTenant: true as const } : undefined),
		toFragment: () => fragment,
		// Composition drops the marker on purpose — see `Condition.scopesTenant`.
		and: (other) => makeCond(raw(`(${compile(fragment)} AND ${compile(other.toFragment())})`)),
		or: (other) => makeCond(raw(`(${compile(fragment)} OR ${compile(other.toFragment())})`)),
	}
}

// Literals

export function lit(value: string): Expr<string>
export function lit(value: number): Expr<number>
export function lit(value: string | number): Expr<string> | Expr<number> {
	// A literal knows its own type, so it carries the matching codec. Without one
	// a single `CH.lit("all")` in a SELECT costs the whole query its row schema,
	// since derivation is all-or-nothing.
	if (typeof value === "string") return makeExpr<string>(str(value), chString.schema)
	return makeExpr<number>(raw(String(value)), CHNumber as Schema.Codec<number, any>)
}

// Subquery expressions
//
// `exists` / `inSubquery` / `notInSubquery` live in `./subquery`, not here —
// they accept a `CHQuery` and so need `compileCH`, which this module cannot
// import without closing a cycle. Reach them from the package root.

/**
 * Reference an outer query's column in a correlated subquery.
 * Usage: `outerRef("t.TraceId")` or `outerRef("TraceId")`
 */
export function outerRef<T = string>(name: string): Expr<T> {
	return makeUntypedExpr<T>(raw(name))
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

// Raw expression (escape hatch)

/**
 * SQL the builder cannot express, as an expression of a declared type.
 *
 * The type is required. Optional is how a raw expression ends up carrying a
 * TypeScript type nothing checks: `rawExpr<number>("sum(x)")` tells the compiler
 * the column is a number and tells the runtime nothing, so a `UInt64` arriving
 * quoted reaches a `Schema.Number` several layers downstream. Declaring
 * `T.float64` costs one argument and makes both directions agree.
 *
 * For SQL whose result genuinely has no type to declare — a sort tuple that is
 * only ever an argument, never a selected value — use {@link untypedExpr}, which
 * says so.
 */
export function rawExpr<T>(sql: string, type: CHType<string, T, any>): Expr<T> {
	return makeExpr<T>(raw(sql), type.schema)
}

/**
 * SQL with no declared result type.
 *
 * Deliberately separate from {@link rawExpr} and deliberately awkward to reach
 * for: selecting one costs the whole query its derived row schema, so the query
 * decodes nothing. `CompiledQuery.rowSchemaSource` reports that as `"none"` and
 * `untypedColumns` names the aliases responsible, so a codebase that cares can
 * assert on it.
 *
 * The legitimate use is a value that never becomes a row: an `ORDER BY` key, an
 * `argMin` tiebreaker, a tuple compared against another tuple.
 */
export function untypedExpr<T = unknown>(sql: string): Expr<T> {
	return makeUntypedExpr<T>(raw(sql))
}

export function rawCond(sql: string): Condition {
	return makeCond(raw(sql))
}

/**
 * An expression from a runtime column name — a `GROUP BY` alias referenced in
 * `HAVING`, or a column of a source the builder cannot see.
 *
 * Pass the column type where you know it: without one the expression has no
 * schema, and one unschema'd field stops the whole query deriving a row schema.
 */
export function dynamicColumn<T = string>(name: string, type?: CHType<string, T, any>): Expr<T> {
	return makeExpr<T>(raw(name), type?.schema)
}

// Aliased expression — used by query compilation

export function aliased<T>(expr: Expr<T>, alias: string): SqlFragment {
	return sqlAs(expr.toFragment(), alias)
}

// Conditional helpers (for optional WHERE clauses)

export function when<T>(value: T | undefined | false | null, fn: (v: T) => Condition): Condition | undefined {
	if (value === undefined || value === null || value === false) return undefined
	return fn(value)
}

export function whenTrue(value: boolean | undefined, fn: () => Condition): Condition | undefined {
	if (!value) return undefined
	return fn()
}
