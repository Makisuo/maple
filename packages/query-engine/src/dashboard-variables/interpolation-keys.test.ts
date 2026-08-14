import { describe, expect, it } from "vitest"
import { interpolateWidgetParams, type VariableValues } from "./interpolate"

/**
 * The guard `packages/widgets/src/dashboard/shared/display.ts` claims exists.
 *
 * Variable interpolation selects its formatting by KEY NAME, not by type: a key
 * ending in `whereclause` gets clause-aware treatment (an "All" selection drops
 * the whole clause), a key named exactly `sql` gets escaped ClickHouse literals,
 * everything else gets plain text. That makes the field names below part of the
 * contract — renaming `listWhereClause` to `listFilter` does not fail to
 * compile, does not fail any schema, and silently sends a literal `$service` to
 * the warehouse.
 *
 * These tests exist to fail loudly when a rename happens. If you are here
 * because one broke: the rename is fine, but the matching rule in
 * `interpolate.ts` has to move with it.
 */

const values: VariableValues = {
	service: { value: "api", isAll: false, options: ["api", "web"] },
	env: { value: "$__all", isAll: true, options: ["prd", "stg"] },
}

describe("interpolation key contract", () => {
	it.each([
		["whereClause", "queries[i].whereClause"],
		["listWhereClause", "display.listWhereClause"],
		["WHERECLAUSE", "any casing"],
	])("treats %s as a where-clause (drops All-selected clauses)", (key) => {
		const out = interpolateWidgetParams(
			{ [key]: "service.name = $service AND environment = $env" },
			values,
		)
		// `$env` is All, so its clause is removed entirely rather than substituted:
		// "All" means "do not filter on this", not "match the literal string".
		// The surviving value is substituted UNQUOTED — a where-clause is parsed by
		// the engine's own grammar, not emitted as SQL. Only `sql` quotes.
		expect(out[key]).toBe("service.name = api")
	})

	it("treats `sql` as SQL and escapes the substituted literal", () => {
		const out = interpolateWidgetParams({ sql: "WHERE service = $service" }, values)
		expect(out.sql).toBe("WHERE service = 'api'")
	})

	it("quotes a value that would otherwise break out of its SQL literal", () => {
		const out = interpolateWidgetParams(
			{ sql: "WHERE service = $service" },
			{ service: { value: "a' OR 1=1 --", isAll: false, options: [] } },
		)
		expect(out.sql).toBe("WHERE service = 'a\\' OR 1=1 --'")
	})

	it("finds a where-clause key at any depth", () => {
		const out = interpolateWidgetParams(
			{ queries: [{ id: "a", whereClause: "service.name = $service" }] },
			values,
		)
		expect(out).toEqual({ queries: [{ id: "a", whereClause: "service.name = api" }] })
	})

	it("uses plain substitution for a key that is NOT a recognised clause name", () => {
		// The negative half of the contract, and the reason the name is
		// load-bearing. Same input as the where-clause cases above: a renamed field
		// stops dropping the All-selected clause and instead expands it to a
		// comma-joined option list, producing `environment = prd,stg` — a filter
		// that matches nothing, where the user asked for no filter at all.
		const clause = "service.name = $service AND environment = $env"
		const renamed = interpolateWidgetParams({ listFilter: clause }, values)
		expect(renamed.listFilter).toBe("service.name = api AND environment = prd,stg")

		const guarded = interpolateWidgetParams({ listWhereClause: clause }, values)
		expect(guarded.listWhereClause).toBe("service.name = api")
	})

	it("leaves `$__` macros alone", () => {
		const out = interpolateWidgetParams(
			{ sql: "SELECT $__timeGroup(Timestamp) WHERE $__orgFilter AND s = $service" },
			values,
		)
		expect(out.sql).toBe("SELECT $__timeGroup(Timestamp) WHERE $__orgFilter AND s = 'api'")
	})

	it("keeps an unknown variable reference literal", () => {
		// Substituting nothing would silently widen the query to match everything.
		const out = interpolateWidgetParams({ whereClause: "a = $nope" }, values)
		expect(out.whereClause).toBe("a = $nope")
	})
})
