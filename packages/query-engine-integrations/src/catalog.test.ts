import { describe, expect, it } from "vitest"
import {
	collectIntegrationCatalog,
	EXEMPT_INTEGRATION_BUILDERS,
	exportedIntegrationBuilders,
	integrationFixtures,
	unfixturedIntegrationBuilders,
	UNDECODED_INTEGRATION_QUERIES,
	undecodedIntegrationColumns,
	undecodedIntegrationQueries,
} from "./catalog"

// The integration-side half of the SQL gate. `@maple/query-engine`'s catalog
// cannot reach these builders — it must not depend on this package — so the
// same guarantees are asserted here: every shape compiles, is tenant-scoped,
// and is pinned byte-for-byte.
describe("integration sql catalog", () => {
	const entries = collectIntegrationCatalog()

	it("compiles every fixture", () => {
		expect(entries.length).toBeGreaterThan(0)
		for (const entry of entries) {
			expect(entry.sql, entry.id).toBeTruthy()
			expect(entry.sql.toUpperCase(), entry.id).toContain("SELECT")
		}
	})

	// Structural, not a substring check on the SQL — see the tenant-scope work in
	// @maple-dev/clickhouse-builder. No integration query reads across tenants.
	it("scopes every query to an org", () => {
		for (const entry of entries) {
			expect(entry.compiled.tenantScope, `${entry.id} tenant scope`).toBe("single-tenant")
		}
	})

	// Fixture coverage is what gives every other assertion here its reach: a
	// builder no fixture compiles is invisible to the row-schema gate, the
	// baseline and the e2e sweep alike.
	it("covers or exempts every exported builder", () => {
		const missing = unfixturedIntegrationBuilders()
		expect(missing, `builders with no fixture and no exemption:\n${missing.join("\n")}`).toEqual([])
	})

	it("declares fixtures whose export actually exists", () => {
		const exported = new Set(exportedIntegrationBuilders())
		for (const fixture of integrationFixtures) {
			expect(exported.has(fixture.name), `${fixture.module} does not export ${fixture.name}`).toBe(true)
		}
	})

	it("keeps the exemption list free of stale entries", () => {
		const exported = new Set(exportedIntegrationBuilders())
		const fixtured = new Set(integrationFixtures.map((fixture) => fixture.name))
		for (const name of EXEMPT_INTEGRATION_BUILDERS) {
			expect(exported.has(name), `${name} is exempt but no longer exported`).toBe(true)
			expect(fixtured.has(name), `${name} is exempt AND fixtured — drop the exemption`).toBe(false)
		}
	})

	// Asserted exactly, not as a ceiling: a query that stops deriving a row
	// schema fails here, and so does one still listed after it starts. The
	// `decodeRows` identity cast is invisible at runtime, so this list is the
	// only place this package can see which of its queries validate nothing.
	it("decodes every query except the declared exceptions", () => {
		const detail = [...undecodedIntegrationColumns(entries)]
			.map(([id, cols]) => `  ${id} — untyped: ${cols.join(", ")}`)
			.join("\n")

		expect(
			undecodedIntegrationQueries(entries),
			`undecoded queries and the columns to type:\n${detail}`,
		).toEqual([...UNDECODED_INTEGRATION_QUERIES].sort())
	})

	// A declared schema replaces the derived one wholesale, so a schema that has
	// fallen behind its SELECT keeps decoding — dropping columns it forgot, or
	// failing on a field the query no longer emits. The builder compares the two
	// shapes by field name; this is where that comparison is asserted.
	it("keeps every declared row schema in step with its SELECT", () => {
		const drifted = entries
			.filter((entry) => entry.compiled.rowSchemaMismatch !== undefined)
			.map((entry) => {
				const mismatch = entry.compiled.rowSchemaMismatch!
				return `  ${entry.id} — undeclared: [${mismatch.undeclared.join(", ")}] unselected: [${mismatch.unselected.join(", ")}]`
			})

		expect(drifted, `declared row schemas that no longer match their query:\n${drifted.join("\n")}`).toEqual(
			[],
		)
	})

	it("emits the same SQL as the recorded baseline", async () => {
		const rendered = [...entries]
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((entry) => `-- ${entry.id}\n${entry.sql}`)
			.join("\n\n")

		await expect(rendered).toMatchFileSnapshot("__sql_baseline__/integrations.sql")
	})
})
