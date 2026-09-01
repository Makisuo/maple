import { describe, expect, it } from "vitest"
import { defaultPrivilegeStatements, sweepStatements } from "./ensure-privileges"

describe("defaultPrivilegeStatements", () => {
	it("keys table and sequence defaults to the given creating role", () => {
		const statements = defaultPrivilegeStatements("postgres")
		expect(statements).toHaveLength(2)
		for (const statement of statements) {
			expect(statement).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA public')
			expect(statement).toContain("TO PUBLIC")
		}
	})

	// The standalone path keys defaults per candidate creating role (login role
	// AND postgres) — the helper must therefore be callable per role, with the
	// dotted PlanetScale login role quoted as one identifier.
	it("quotes a dotted PlanetScale login role", () => {
		const statements = defaultPrivilegeStatements("pscale_api_abc.def")
		expect(statements[0]).toContain('FOR ROLE "pscale_api_abc.def"')
	})
})

describe("sweepStatements", () => {
	it("backfills existing tables and sequences to PUBLIC", () => {
		expect(sweepStatements.some((s) => s.includes("ON ALL TABLES IN SCHEMA public"))).toBe(true)
		expect(sweepStatements.some((s) => s.includes("ON ALL SEQUENCES IN SCHEMA public"))).toBe(true)
	})
})
