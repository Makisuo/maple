import { PGlite } from "@electric-sql/pglite"
import { describe, expect, it } from "vitest"
import { readBundledMigrationsSql } from "./migrate"

/**
 * Columns consumed by an external, read-only system.
 *
 * That system reads this database directly and lives outside this repository,
 * so a rename or drop here is invisible to it until it breaks at runtime — and
 * because it reads on a background schedule, the failure surfaces long after
 * the deploy that caused it. This test is the only mechanism that catches such
 * a change *in the PR that makes it*.
 *
 * If a change here is intentional, update this list in the same PR and treat it
 * as a coordinated change: the consumer has to ship its side first. Adding a
 * column is always safe; renaming, dropping, or changing the type of one listed
 * below is not.
 *
 * Scope is deliberately narrow — only columns actually read. Do not add a table
 * here "for completeness"; every entry is a constraint on future migrations.
 */
const EXTERNALLY_CONSUMED: Readonly<Record<string, ReadonlyArray<string>>> = {
	// Lifecycle state. The four `*_email_sent_at` columns are listed because the
	// consumer's one-time backfill reads them; they can be dropped once that
	// backfill is retired, but not before.
	org_onboarding_state: [
		"org_id",
		"user_id",
		"email",
		"created_at",
		"first_data_received_at",
		"onboarding_completed_at",
		"welcome_email_sent_at",
		"connect_nudge_email_sent_at",
		"stalled_email_sent_at",
		"activation_email_sent_at",
	],
	// The only per-user contact record with a delivery preference.
	digest_subscriptions: ["org_id", "user_id", "email", "enabled", "last_sent_at"],
	// Integration breadth — read as booleans ("has this org connected X"), so
	// only the join key matters.
	slack_workspaces: ["org_id"],
	planetscale_connections: ["org_id"],
	oauth_connections: ["org_id", "provider"],
	dashboards: ["org_id"],
	alert_rules: ["org_id"],
} satisfies Readonly<Record<string, ReadonlyArray<string>>>

interface ColumnRow {
	readonly table_name: string
	readonly column_name: string
}

/**
 * One PGlite boot for the whole suite — replaying every migration is ~5s, well
 * over vitest's default timeout, so this mirrors the 30s bound in
 * migrations.test.ts rather than booting per assertion.
 */
describe("externally consumed columns", () => {
	it("still exist after every migration is applied", async () => {
		const pg = new PGlite()
		await pg.exec(readBundledMigrationsSql())

		const tables = Object.keys(EXTERNALLY_CONSUMED)
		const result = await pg.query<ColumnRow>(
			`select table_name, column_name
			   from information_schema.columns
			  where table_schema = 'public' and table_name = any($1)`,
			[tables],
		)

		const present = new Map<string, Set<string>>()
		for (const row of result.rows) {
			const columns = present.get(row.table_name) ?? new Set<string>()
			columns.add(row.column_name)
			present.set(row.table_name, columns)
		}

		// Collect every missing column before failing, so a rename that touches
		// several tables reports all of them in one run instead of one per fix.
		const missing: string[] = []
		for (const [table, columns] of Object.entries(EXTERNALLY_CONSUMED)) {
			const actual = present.get(table)
			if (!actual) {
				missing.push(`${table} (table missing entirely)`)
				continue
			}
			for (const column of columns) {
				if (!actual.has(column)) missing.push(`${table}.${column}`)
			}
		}

		expect(
			missing,
			`Missing columns consumed by an external read-only system:\n  ${missing.join("\n  ")}\n\n` +
				"If this rename or drop is intentional, the external consumer must ship its side\n" +
				"first, then this list is updated in the same PR as the migration.",
		).toEqual([])
	}, 30_000)
})
