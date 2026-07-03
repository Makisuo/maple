import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { describe, expect, it } from "vitest"
import { readBundledMigrationsSql } from "./migrate"

type MigrationJournal = {
	readonly entries: ReadonlyArray<{
		readonly idx: number
		readonly tag: string
		readonly when: number
	}>
}

const readJournal = (): MigrationJournal => {
	const path = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle/meta/_journal.json")
	return JSON.parse(readFileSync(path, "utf8")) as MigrationJournal
}

describe("drizzle migrations", () => {
	it("keeps journal timestamps increasing in migration order", () => {
		const { entries } = readJournal()

		for (let i = 0; i < entries.length; i++) {
			expect(entries[i]!.idx).toBe(i)
			if (i === 0) continue

			// Drizzle only compares each journal timestamp against the highest
			// created_at already recorded in the DB. A lower timestamp after a
			// deployed migration is silently skipped on the next migrate.
			expect(
				entries[i]!.when,
				`${entries[i]!.tag} must be newer than ${entries[i - 1]!.tag}`,
			).toBeGreaterThan(entries[i - 1]!.when)
		}
	})
})

// The bundled migrations are applied to a fresh PGlite instance via a single
// `exec()` (see readBundledMigrationsSql). This guards two things at once:
//   1. Every migration — including the Electric publication (0009) — parses and
//      applies in PGlite, so the test harness never breaks on new DDL.
//   2. The ElectricSQL publication + REPLICA IDENTITY FULL actually land, which
//      is what Electric needs to serve these tables as shapes.
//
// One PGlite boot for both assertions, with a generous timeout: booting the
// WASM engine + replaying every migration is ~5s on CI runners (well over
// vitest's 5s default), so the whole `it` is bounded at 30s.
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

	it(
		"apply cleanly and create the Electric publication with REPLICA IDENTITY FULL",
		async () => {
			const pg = new PGlite()
			await expect(pg.exec(readBundledMigrationsSql())).resolves.toBeDefined()

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
		},
		30_000,
	)
})
