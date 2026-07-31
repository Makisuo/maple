import { readdirSync, readFileSync } from "node:fs"
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

const migrationsDir = () => resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle")

const readMigrationSqlBefore = (tag: string): string =>
	readdirSync(migrationsDir())
		.filter((file) => file.endsWith(".sql") && file < `${tag}.sql`)
		.sort()
		.map((file) => readFileSync(resolve(migrationsDir(), file), "utf8"))
		.join("\n")

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
		// Wave 1 (0011_electric_publication_wave1)
		"alert_destinations",
		// API-key live reads (0014_electric_publication_api_keys)
		"api_keys",
	]

	// Published by 0009/0011, then pruned by 0022 once their client collections were
	// removed. Asserted explicitly so re-adding a table to the publication without a
	// consumer (or a prune migration that silently no-ops) fails here.
	const UNSYNCED_TABLES = ["error_issues", "actors", "error_incidents", "scrape_target_checks"]

	it("apply cleanly and create the Electric publication with REPLICA IDENTITY FULL", async () => {
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

		// 'd' = DEFAULT (primary key only). An unpublished table must not keep paying
		// FULL's WAL cost — writing the whole old row on every UPDATE/DELETE.
		const pruned = await pg.query<{ relname: string; relreplident: string }>(
			`select relname, relreplident from pg_class where relname = any($1)`,
			[UNSYNCED_TABLES],
		)
		expect(pruned.rows.map((r) => r.relname).sort()).toEqual([...UNSYNCED_TABLES].sort())
		for (const row of pruned.rows) {
			expect(row.relreplident, `${row.relname} replica identity`).toBe("d")
		}
	}, 30_000)

	it("converts metric rules and removes retired destinations without runtime compatibility", async () => {
		const pg = new PGlite()
		await pg.exec(readMigrationSqlBefore("0026_windy_bromley"))

		const now = "2026-07-31T00:00:00.000Z"
		await pg.query(
			`INSERT INTO alert_destinations (
				id, org_id, name, type, config_json, secret_ciphertext, secret_iv, secret_tag,
				created_at, updated_at, created_by, updated_by
			) VALUES
				('dest_slack', 'org_1', 'Old Slack', 'slack', '{}', 'x', 'x', 'x', $1, $1, 'user_1', 'user_1'),
				('dest_webhook', 'org_1', 'Webhook', 'webhook', '{}', 'x', 'x', 'x', $1, $1, 'user_1', 'user_1')`,
			[now],
		)
		await pg.query(
			`INSERT INTO alert_rules (
				id, org_id, name, severity, service_names_json, environments_json, signal_type,
				comparator, threshold, window_minutes, metric_name, metric_type, metric_aggregation,
				destination_ids_json, query_spec_json, reducer, no_data_behavior,
				created_at, updated_at, created_by, updated_by
			) VALUES
				(
					'rule_multi', 'org_1', 'Multi-service metric', 'warning',
					'["api", "checkout"]', '["prod", "staging"]', 'metric',
					'gt', 10, 5, 'http.requests', 'sum', 'rate',
					'["dest_slack", "dest_webhook"]', '{"preserved": true}', 'max', 'skip',
					$1, $1, 'user_1', 'user_1'
				),
				(
					'rule_orphaned', 'org_1', 'Only retired destination', 'warning',
					NULL, NULL, 'error_rate', 'gt', 0.1, 5, NULL, NULL, NULL,
					'["dest_slack"]', '{}', 'max', 'skip',
					$1, $1, 'user_1', 'user_1'
				)`,
			[now],
		)

		await pg.exec(readFileSync(resolve(migrationsDir(), "0026_windy_bromley.sql"), "utf8"))

		const migrated = await pg.query<{
			signal_type: string
			service_names_json: unknown
			environments_json: unknown
			group_by: string | null
			destination_ids_json: string[]
			query_spec_json: { preserved?: boolean }
			query_builder_draft_json: {
				whereClause: string
				groupBy: string[]
				addOns: { groupBy: boolean }
			}
		}>("SELECT * FROM alert_rules WHERE id = 'rule_multi'")
		expect(migrated.rows[0]).toMatchObject({
			signal_type: "builder_query",
			service_names_json: null,
			environments_json: null,
			group_by: null,
			destination_ids_json: ["dest_webhook"],
			query_spec_json: { preserved: true },
			query_builder_draft_json: {
				whereClause: 'service.name = "api,checkout" AND deployment.environment = "prod,staging"',
				groupBy: ["service.name"],
				addOns: { groupBy: true },
			},
		})

		const orphaned = await pg.query<{ enabled: boolean; destination_ids_json: string[] }>(
			"SELECT enabled, destination_ids_json FROM alert_rules WHERE id = 'rule_orphaned'",
		)
		expect(orphaned.rows[0]).toEqual({ enabled: false, destination_ids_json: [] })

		const retired = await pg.query("SELECT id FROM alert_destinations WHERE type IN ('slack', 'hazel')")
		expect(retired.rows).toEqual([])

		const columns = await pg.query<{ column_name: string }>(
			`SELECT column_name
			 FROM information_schema.columns
			 WHERE table_name = 'alert_rules'
				AND column_name IN ('metric_name', 'metric_type', 'metric_aggregation')`,
		)
		expect(columns.rows).toEqual([])
	}, 30_000)
})
