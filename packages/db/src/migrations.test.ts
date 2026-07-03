import { PGlite } from "@electric-sql/pglite"
import { describe, expect, it } from "vitest"
import { readBundledMigrationsSql } from "./migrate"

// The bundled migrations are applied to fresh PGlite instances via a single
// `exec()` (see readBundledMigrationsSql). This guards two things at once:
//   1. Every migration — including the Electric publication (0009) — parses and
//      applies in PGlite, so the test harness never breaks on new DDL.
//   2. The ElectricSQL publication + REPLICA IDENTITY FULL actually land, which
//      is what Electric needs to serve these tables as shapes.
describe("bundled migrations", () => {
	const SYNCED_TABLES = [
		"dashboards",
		"alert_rules",
		"alert_rule_states",
		"alert_incidents",
		"error_issues",
		"actors",
		"error_incidents",
	]

	it("apply cleanly to a fresh PGlite database", async () => {
		const pg = new PGlite()
		await expect(pg.exec(readBundledMigrationsSql())).resolves.toBeDefined()
	})

	it("create the Electric publication over the synced tables with REPLICA IDENTITY FULL", async () => {
		const pg = new PGlite()
		await pg.exec(readBundledMigrationsSql())

		const pubs = await pg.query<{ pubname: string }>("select pubname from pg_publication")
		expect(pubs.rows.map((r) => r.pubname)).toContain("electric_publication_default")

		const members = await pg.query<{ tablename: string }>(
			"select tablename from pg_publication_tables where pubname = 'electric_publication_default'",
		)
		expect(members.rows.map((r) => r.tablename).sort()).toEqual([...SYNCED_TABLES].sort())

		// relreplident 'f' = FULL — Electric needs the full old row to key deletes
		// on composite-PK tables and to emit deletes when a row leaves a shape.
		const identities = await pg.query<{ relname: string; relreplident: string }>(
			`select relname, relreplident from pg_class where relname = any($1)`,
			[SYNCED_TABLES],
		)
		for (const row of identities.rows) {
			expect(row.relreplident, `${row.relname} replica identity`).toBe("f")
		}
	})
})
