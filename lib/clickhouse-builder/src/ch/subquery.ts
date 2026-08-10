// Subquery conditions
//
// These live here rather than in `expr.ts` because they need `compileCH`, and
// `expr.ts` is imported by both `query.ts` and `compile.ts`. Putting the import
// there would close the cycle `expr → compile → query → expr`, which survives
// today only because everything crossing it is a hoisted `function` declaration
// — one top-level `const` away from a TDZ crash in the bundle.

import { compileCH } from "./compile"
import { type Condition, type Expr, makeCond } from "./expr"
import type { CHQuery } from "./query"
import { compile, raw } from "../sql/sql-fragment"

/**
 * A subquery, either as a builder query or as SQL someone compiled elsewhere.
 *
 * The string arm exists for the handful of places that genuinely hold only SQL
 * (a CTE body read from a catalog, say). Prefer the query arm: it keeps the
 * inner query's params, table names and column types checked.
 */
export type Subquery = string | CHQuery<any, any, any>

/**
 * Compile a subquery to bare SQL.
 *
 * Compiling with no params is deliberate, not a shortcut. `compileCH`
 * substitutes `__PARAM_x__` placeholders across the whole assembled string as
 * its last step, so placeholders inside a spliced subquery survive to the outer
 * query's substitution pass and are resolved there with the outer params.
 */
const toSql = (subquery: Subquery): string =>
	typeof subquery === "string" ? subquery : compileCH(subquery, {}, { skipFormat: true }).sql

// A note that applies to all three of these:
//
// A subquery condition contributes NOTHING to the outer query's tenant scope,
// even when the subquery itself filters `OrgId`. `WHERE x IN (SELECT y FROM t
// WHERE OrgId = 'a')` does not confine the outer read to org `a` — nothing stops
// org `b` from having the same `y`. The outer query must still carry its own
// tenant predicate, or read only from sources that are themselves scoped.
// `makeCond` without the `scopesTenant` flag is what encodes that.

/** `EXISTS (subquery)` — for correlated subqueries (see `outerRef`). */
export function exists(subquery: Subquery): Condition {
	return makeCond(raw(`EXISTS (${toSql(subquery)})`))
}

/** `expr IN (subquery)`. */
export function inSubquery<T>(expr: Expr<T>, subquery: Subquery): Condition {
	return makeCond(raw(`${compile(expr.toFragment())} IN (${toSql(subquery)})`))
}

/**
 * `expr NOT IN (subquery)` — an anti-join expressed as a predicate.
 *
 * Note ClickHouse's NULL semantics: if the subquery yields any NULL, `NOT IN`
 * is never true. Project a non-nullable column, or filter the NULLs inside.
 */
export function notInSubquery<T>(expr: Expr<T>, subquery: Subquery): Condition {
	return makeCond(raw(`${compile(expr.toFragment())} NOT IN (${toSql(subquery)})`))
}
