import { describe, expect, it } from "vitest"
import {
	collectIntegrationCatalog,
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

	it("emits the same SQL as the recorded baseline", async () => {
		const rendered = [...entries]
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((entry) => `-- ${entry.id}\n${entry.sql}`)
			.join("\n\n")

		await expect(rendered).toMatchFileSnapshot("__sql_baseline__/integrations.sql")
	})
})
