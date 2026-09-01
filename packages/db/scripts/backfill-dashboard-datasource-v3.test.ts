// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type postgres from "postgres"
import { describe, expect, it } from "vitest"
import {
	backfillDashboards,
	backfillVersionSnapshots,
	openJournal,
	restore,
	type Args,
	type JournalLine,
	type RecoveryJournal,
} from "./backfill-dashboard-datasource-v3"

// A minimal v2 document (route data source) that `classify` upgrades and
// decodes cleanly — mirrors the fixture in packages/widgets' upgrade tests.
const v2Document = {
	id: "3f1b7c62-5a1e-4d0f-9a3b-6c2e8d4f1a90",
	schemaVersion: 2,
	name: "Board",
	timeRange: { type: "relative", value: "1h" },
	widgets: [
		{
			id: "widget-1",
			visualization: "chart",
			dataSource: { endpoint: "service_overview", params: { serviceName: "api" } },
			display: { title: "T" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
	],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
}

const applyArgs: Args = {
	apply: true,
	batch: 100,
	dump: "unused.jsonl",
	quarantine: "unused-quarantine.jsonl",
	skipVersions: false,
}

interface Captured {
	readonly text: string
	readonly values: unknown[]
}

/**
 * Fake postgres.js client: records every statement (template text with `$`
 * where a parameter goes) and an ordered event log, answers via `respond`.
 */
const makeFakeSql = (respond: (query: Captured) => unknown[]) => {
	const queries: Captured[] = []
	const events: string[] = []
	const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
		const captured = { text: strings.join("$"), values }
		queries.push(captured)
		events.push(captured.text.includes("UPDATE") ? "update" : "select")
		return Promise.resolve(respond(captured))
	}
	const sql = Object.assign(tag, {
		json: (value: unknown) => value,
		begin: async (callback: (tx: unknown) => Promise<void>) => {
			events.push("begin")
			await callback(sql)
			events.push("commit")
		},
		end: async () => {},
	})
	// SAFETY: the script only uses the tagged-template call, `.json`, `.begin`
	// and `.end` — exactly the surface this double implements.
	return { sql: sql as unknown as postgres.Sql, queries, events }
}

const noopQuarantine = () => {}

const recordingJournal = () => {
	const lines: JournalLine[] = []
	const journal: RecoveryJournal = {
		append: (line) => lines.push(line),
		flush: () => {},
		close: () => {},
		count: () => lines.length,
	}
	return { journal, lines }
}

describe("openJournal", () => {
	it("persists appended lines on flush, before anything else runs", () => {
		const dir = mkdtempSync(join(tmpdir(), "backfill-journal-"))
		const path = join(dir, "dump.jsonl")
		const journal = openJournal(path)
		journal.append({ table: "dashboards", org_id: "o1", id: "d1", version: 3, upgraded_json: {} })
		journal.flush()
		// The line is on disk NOW — not at process exit.
		const written = readFileSync(path, "utf8").trim().split("\n")
		expect(written).toHaveLength(1)
		expect(JSON.parse(written[0]!)).toMatchObject({ table: "dashboards", org_id: "o1", id: "d1" })
		journal.close()
	})
})

describe("backfillDashboards", () => {
	it("flushes the journal before opening the batch transaction", async () => {
		const row = { org_id: "o1", id: "d1", version: 4, payload_json: v2Document }
		const { sql, events } = makeFakeSql((query) =>
			query.text.includes("UPDATE") ? [{ id: "d1" }] : query.text.includes("SELECT") ? [row] : [],
		)
		// Shares the fake sql's event array so the interleaving is observable.
		const lines: JournalLine[] = []
		const journal: RecoveryJournal = {
			append: (line) => {
				lines.push(line)
				events.push("journal-append")
			},
			flush: () => events.push("journal-flush"),
			close: () => {},
			count: () => lines.length,
		}

		const report = await backfillDashboards(sql, applyArgs, journal, noopQuarantine)
		const merged = events

		expect(report.converted).toBe(1)
		// The preimage (and the upgraded payload restore will verify against)
		// hit the fsynced journal BEFORE the transaction that writes the row.
		const flushAt = merged.indexOf("journal-flush")
		const beginAt = merged.indexOf("begin")
		expect(flushAt).toBeGreaterThan(-1)
		expect(beginAt).toBeGreaterThan(flushAt)
		expect(lines[0]).toMatchObject({ table: "dashboards", org_id: "o1", id: "d1", version: 4 })
		expect(lines[0]?.upgraded_json).toBeDefined()
	})
})

describe("backfillVersionSnapshots", () => {
	it("journals snapshot preimages and CASes on the original snapshot", async () => {
		const row = { org_id: "o1", id: "v1", snapshot_json: v2Document }
		const { sql, queries } = makeFakeSql((query) =>
			query.text.includes("UPDATE") ? [{ id: "v1" }] : query.text.includes("SELECT") ? [row] : [],
		)
		const { journal, lines } = recordingJournal()

		const report = await backfillVersionSnapshots(sql, applyArgs, journal, noopQuarantine)

		expect(report.converted).toBe(1)
		expect(lines[0]).toMatchObject({ table: "dashboard_versions", org_id: "o1", id: "v1" })
		const update = queries.find((query) => query.text.includes("UPDATE dashboard_versions"))
		// The original snapshot is the compare-and-swap condition: a coalesced
		// save that rewrote the row between SELECT and UPDATE must miss.
		expect(update?.text).toContain("AND snapshot_json = $::jsonb")
		expect(update?.values).toContainEqual(row.snapshot_json)
	})

	it("reports a concurrent rewrite as a CAS miss, not a conversion", async () => {
		const row = { org_id: "o1", id: "v1", snapshot_json: v2Document }
		const { sql } = makeFakeSql((query) =>
			query.text.includes("UPDATE") ? [] : query.text.includes("SELECT") ? [row] : [],
		)
		const { journal } = recordingJournal()

		const report = await backfillVersionSnapshots(sql, applyArgs, journal, noopQuarantine)

		expect(report.converted).toBe(0)
		expect(report.casMissed).toBe(1)
	})
})

describe("restore", () => {
	const writeDump = (lines: ReadonlyArray<JournalLine>): string => {
		const dir = mkdtempSync(join(tmpdir(), "backfill-restore-"))
		const path = join(dir, "dump.jsonl")
		writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
		return path
	}

	it("verifies the row still holds the backfill's payload and advances version", async () => {
		const preimage = { schemaVersion: 2, widgets: [] }
		const upgraded = { schemaVersion: 3, widgets: [] }
		const path = writeDump([
			{
				table: "dashboards",
				org_id: "o1",
				id: "d1",
				version: 4,
				payload_json: preimage,
				upgraded_json: upgraded,
			},
		])
		const { sql, queries } = makeFakeSql(() => [{ id: "d1" }])

		await restore(sql, path)

		const update = queries[0]
		// Version N+1 alone is NOT proof the backfill owns the row — a CAS-missed
		// backfill leaves the user's edit at N+1. The current payload must equal
		// the exact value the backfill wrote.
		expect(update?.text).toContain("AND payload_json = $::jsonb")
		expect(update?.values).toContainEqual(upgraded)
		expect(update?.values).toContain(5)
		// The optimistic-concurrency counter is monotonic: restore bumps it
		// forward instead of handing back the pre-backfill value a stale tab
		// could still CAS against.
		expect(update?.text).toContain("version = version + 1")
		expect(update?.text).not.toContain("version = $,")
	})

	it("restores dashboard_versions lines against the written snapshot", async () => {
		const preimage = { schemaVersion: 2, widgets: [] }
		const upgraded = { schemaVersion: 3, widgets: [] }
		const path = writeDump([
			{
				table: "dashboard_versions",
				org_id: "o1",
				id: "v1",
				snapshot_json: preimage,
				upgraded_json: upgraded,
			},
		])
		const { sql, queries } = makeFakeSql(() => [{ id: "v1" }])

		await restore(sql, path)

		const update = queries[0]
		expect(update?.text).toContain("UPDATE dashboard_versions")
		expect(update?.text).toContain("AND snapshot_json = $::jsonb")
		expect(update?.values).toContainEqual(upgraded)
		expect(update?.values).toContainEqual(preimage)
	})
})
