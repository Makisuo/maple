// Handwritten SQL — Maple's review gate
//
// The builder takes `reason` as any string: what counts as legitimate raw SQL
// is a policy of the codebase using it, not of a generic query builder. This is
// where Maple pins that policy.

import {
	type CompiledQuery,
	unsafeCompiledQuery as unsafeCompiledQueryUntyped,
} from "@maple-dev/clickhouse-builder"
import type { CompiledQueryRowSchema, TenantScope } from "@maple-dev/clickhouse-builder"

/**
 * Why a query is handwritten SQL rather than a builder query.
 *
 * This union is the boundary between legitimate raw SQL and raw SQL nobody got
 * round to converting — and adding a member is the review gate. It is a
 * one-line diff in this file that a reviewer cannot miss, and it travels with
 * the definition, so it survives file moves and copy-paste into new packages in
 * a way a checked-in call-site list or a lint rule with an allowlist of paths
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
 * every use has to name a `reason` from the closed union above and justify
 * itself in a `note`.
 *
 * DDL, migrations, and another engine's file formats don't reach this function
 * at all; they never produce a `CompiledQuery`.
 */
export const unsafeCompiledQuery = <Output, Routing extends string | undefined = undefined>(args: {
	readonly sql: string
	readonly tenantScope: TenantScope
	readonly reason: RawSqlReason
	/** One sentence, at the call site, on why this instance qualifies. */
	readonly note: string
	readonly rowSchema?: CompiledQueryRowSchema<Output>
	readonly routing?: Routing
}): CompiledQuery<Output, Routing> => unsafeCompiledQueryUntyped<Output, Routing, RawSqlReason>(args)
