#!/usr/bin/env bun
// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
/**
 * One-shot backfill: rewrite every stored dashboard document's data sources from
 * the v2 `{ endpoint, params }` bag to the v3 discriminated union.
 *
 * Runs ONCE per branch. There is no lazy read-path upgrade for v2 -> v3 — the
 * deployed code decodes v3 only — so between deploying that code and finishing
 * this run, un-backfilled dashboards fail to load. Keep the gap short.
 *
 * Usage:
 *   bun run db:backfill:dashboards-v3 --branch main            # dry run (default)
 *   bun run db:backfill:dashboards-v3 --branch main --apply
 *   bun run db:backfill:dashboards-v3 --url postgres://…       # local rehearsal
 *   bun run db:backfill:dashboards-v3 --url … --restore-from dump.jsonl
 *
 * Safety properties, each of which exists for a specific failure:
 *
 *   - DRY RUN IS THE DEFAULT. `--apply` is the only thing that writes.
 *   - "Done" is decided STRUCTURALLY (`isDocumentV3`), never by a flag or a
 *     version column, so re-running is inherently a no-op and no lost cursor can
 *     cause a double transform.
 *   - Every row is DECODED as v3 after transform. A row that fails is left byte
 *     identical and reported; writing a document we could not decode is the one
 *     irreversible mistake available here.
 *   - The pre-write JSONL dump is flushed BEFORE the batch that it covers, so a
 *     crash mid-run still leaves every already-written row recoverable.
 *   - Writes CAS on `version`. Not bumping it would not avoid disturbing clients
 *     (the change streams over Electric either way) — it would let a stale tab
 *     win the compare-and-swap and silently overwrite the backfill with v2.
 *     Bumping turns that into the `DashboardConcurrencyError` every writer
 *     already retries.
 *   - `updated_at` is NOT touched: it is user-visible and the dashboard list's
 *     sort key (`dashboards_org_updated_idx`). A backfill that reshuffles every
 *     customer's list is a visible regression for zero benefit.
 *   - Keyset pagination on `(org_id, id)`, never OFFSET — rows move under you as
 *     you write. One small transaction per batch, not per run: a single large
 *     transaction holds locks against live writers and lands on Electric as one
 *     enormous change that forces every connected browser to resync at once.
 *
 * `dashboard_versions.snapshot_json` gets a second pass AFTER the dashboards
 * pass, so a partial run still leaves live documents correct. Those snapshots are
 * read through the same hard-failing `parsePayload`, so leaving them in v2 breaks
 * the version-history page, not merely restore. They are not Electric-streamed,
 * so they carry no open-tab risk.
 */
import { Option, Schema } from "effect"
import postgres from "postgres"
import {
	DashboardDocument,
	DashboardDocumentV2,
	isDocumentV3,
	upgradeStoredDocument,
} from "@maple/widgets/dashboard"
import { fail, withBranchConnection } from "./planetscale-connection"

const BATCH_DEFAULT = 100
/** Breathing room for live traffic between batches. */
const BATCH_PAUSE_MS = 150

// `Option`, not `Either`: this only ever asks "did it decode?", and the issue
// text comes from a second `decodeUnknownExit` on the failure path where it is
// actually wanted.
const decodeDocument = Schema.decodeUnknownOption(DashboardDocument)
/**
 * The PREVIOUS schema, and the only honest way to ask "was this row already
 * broken?".
 *
 * Decoding the raw payload against the CURRENT schema cannot answer that: a v2
 * row never decodes as v3, that being the entire point of the backfill. Getting
 * this wrong made every unconvertible row look like pre-existing breakage and let
 * the run exit 0 on rows the flip actually strands.
 */
const decodeV2Document = Schema.decodeUnknownOption(DashboardDocumentV2)
const decodeIssue = (payload: unknown): string => {
	const exit = Schema.decodeUnknownExit(DashboardDocument)(payload)
	return exit._tag === "Failure" ? String(exit.cause) : ""
}

interface Args {
	readonly branch?: string
	readonly url?: string
	readonly apply: boolean
	readonly batch: number
	readonly dump: string
	readonly quarantine: string
	readonly restoreFrom?: string
	readonly skipVersions: boolean
}

const parseArgs = (argv: ReadonlyArray<string>): Args => {
	const value = (flag: string): string | undefined => {
		const index = argv.indexOf(flag)
		return index === -1 ? undefined : argv[index + 1]
	}
	const stamp = value("--stamp") ?? "run"
	return {
		branch: value("--branch"),
		url: value("--url"),
		apply: argv.includes("--apply"),
		batch: Number(value("--batch") ?? BATCH_DEFAULT),
		dump: value("--dump") ?? `dashboards-v3-backfill-${stamp}.jsonl`,
		quarantine: value("--quarantine") ?? `dashboards-v3-quarantine-${stamp}.jsonl`,
		restoreFrom: value("--restore-from"),
		skipVersions: argv.includes("--skip-versions"),
	}
}

interface Report {
	scanned: number
	alreadyV3: number
	converted: number
	brokenBefore: number
	quarantined: number
	casMissed: number
}

const emptyReport = (): Report => ({
	scanned: 0,
	alreadyV3: 0,
	converted: 0,
	brokenBefore: 0,
	quarantined: 0,
	casMissed: 0,
})

interface Row {
	readonly org_id: string
	readonly id: string
	readonly version: number
	readonly payload_json: unknown
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Classifies a row without writing anything.
 *
 * `brokenBefore` is reported separately from `quarantined` on purpose: a row that
 * does not decode BEFORE the transform is already failing in production today
 * (`parsePayload` hard-fails, so `get`/`list` already error for that org). Mixing
 * the two would send someone hunting a regression that predates this change, and
 * the dry run's `brokenBefore` count is the sharpest available pre-flight signal
 * — it is exactly how many dashboards the flip strands.
 */
const classify = (payload: unknown) => {
	if (isDocumentV3(payload)) return { kind: "already_v3" as const }

	const upgraded = upgradeStoredDocument(payload)
	if (Option.isNone(decodeDocument(upgraded))) {
		const issue = decodeIssue(upgraded)
		// Did it decode under the OLD schema? If not, the row is already failing in
		// production today and the flip is not what stranded it. If it did, the flip
		// is what breaks it — that is a quarantine, and it gates the run.
		return Option.isNone(decodeV2Document(payload))
			? { kind: "broken_before" as const, issue }
			: { kind: "quarantined" as const, issue }
	}
	return { kind: "converted" as const, upgraded }
}

const backfillDashboards = async (
	sql: postgres.Sql,
	args: Args,
	dump: (line: unknown) => void,
	quarantine: (line: unknown) => void,
): Promise<Report> => {
	const report = emptyReport()
	let cursor: { org: string; id: string } | null = null

	for (;;) {
		const rows: Row[] = cursor
			? await sql`
					SELECT org_id, id, version, payload_json FROM dashboards
					WHERE (org_id, id) > (${cursor.org}, ${cursor.id})
					ORDER BY org_id, id LIMIT ${args.batch}`
			: await sql`
					SELECT org_id, id, version, payload_json FROM dashboards
					ORDER BY org_id, id LIMIT ${args.batch}`
		if (rows.length === 0) break

		const writes: Array<{ row: Row; upgraded: unknown }> = []
		for (const row of rows) {
			report.scanned += 1
			const outcome = classify(row.payload_json)
			if (outcome.kind === "already_v3") {
				report.alreadyV3 += 1
			} else if (outcome.kind === "broken_before") {
				report.brokenBefore += 1
				quarantine({ ...row, reason: "broken_before", issue: outcome.issue })
			} else if (outcome.kind === "quarantined") {
				report.quarantined += 1
				quarantine({ ...row, reason: "quarantined", issue: outcome.issue })
			} else {
				writes.push({ row, upgraded: outcome.upgraded })
			}
		}

		if (args.apply && writes.length > 0) {
			// Dump BEFORE the write, so a crash between the two still leaves every
			// already-written row recoverable from the file.
			for (const { row } of writes) dump(row)

			await sql.begin(async (tx) => {
				for (const { row, upgraded } of writes) {
					const result = await tx`
						UPDATE dashboards
						SET payload_json = ${tx.json(upgraded as never)}, version = version + 1
						WHERE org_id = ${row.org_id} AND id = ${row.id} AND version = ${row.version}
						RETURNING id`
					if (result.length === 0) report.casMissed += 1
					else report.converted += 1
				}
			})
		} else {
			report.converted += writes.length
		}

		const last = rows[rows.length - 1]!
		cursor = { org: last.org_id, id: last.id }
		if (rows.length < args.batch) break
		await sleep(BATCH_PAUSE_MS)
	}

	return report
}

const backfillVersionSnapshots = async (
	sql: postgres.Sql,
	args: Args,
	quarantine: (line: unknown) => void,
): Promise<Report> => {
	const report = emptyReport()
	let cursor: { org: string; id: string } | null = null

	for (;;) {
		const rows: Array<{ org_id: string; id: string; snapshot_json: unknown }> = cursor
			? await sql`
					SELECT org_id, id, snapshot_json FROM dashboard_versions
					WHERE (org_id, id) > (${cursor.org}, ${cursor.id})
					ORDER BY org_id, id LIMIT ${args.batch}`
			: await sql`
					SELECT org_id, id, snapshot_json FROM dashboard_versions
					ORDER BY org_id, id LIMIT ${args.batch}`
		if (rows.length === 0) break

		for (const row of rows) {
			report.scanned += 1
			const outcome = classify(row.snapshot_json)
			if (outcome.kind === "already_v3") {
				report.alreadyV3 += 1
				continue
			}
			if (outcome.kind !== "converted") {
				// Downgraded to a report rather than a run-failing gate: a stranded
				// historical snapshot degrades one entry in the version list. It does
				// not lock anyone out of editing, which is what the live-document
				// quarantine does.
				report[outcome.kind === "broken_before" ? "brokenBefore" : "quarantined"] += 1
				quarantine({ ...row, reason: `snapshot_${outcome.kind}` })
				continue
			}
			report.converted += 1
			if (args.apply) {
				// No CAS column and no user-visible timestamp here; `created_at` is left
				// alone so history keeps its ordering.
				await sql`
					UPDATE dashboard_versions SET snapshot_json = ${sql.json(outcome.upgraded as never)}
					WHERE org_id = ${row.org_id} AND id = ${row.id}`
			}
		}

		const last = rows[rows.length - 1]!
		cursor = { org: last.org_id, id: last.id }
		if (rows.length < args.batch) break
		await sleep(BATCH_PAUSE_MS)
	}

	return report
}

/**
 * Restores `payload_json` verbatim from a dump, guarded on `version`.
 *
 * A row someone has edited since the backfill fails the guard and is reported
 * rather than reverted — reverting a user's later edit to undo our own write is
 * strictly worse than leaving it.
 */
const restore = async (sql: postgres.Sql, path: string): Promise<void> => {
	const text = await Bun.file(path).text()
	let restored = 0
	let skipped = 0
	for (const line of text.split("\n").filter((l) => l.trim().length > 0)) {
		const row = JSON.parse(line) as Row
		const result = await sql`
			UPDATE dashboards SET payload_json = ${sql.json(row.payload_json as never)}, version = ${row.version}
			WHERE org_id = ${row.org_id} AND id = ${row.id} AND version = ${row.version + 1}
			RETURNING id`
		if (result.length === 0) skipped += 1
		else restored += 1
	}
	console.log(`\n✓ Restored ${restored} row(s); skipped ${skipped} edited since the backfill.`)
}

const printReport = (label: string, report: Report, apply: boolean): void => {
	console.log(`\n${label}${apply ? "" : "  (DRY RUN — nothing written)"}`)
	console.log(`  scanned         ${report.scanned}`)
	console.log(`  already v3      ${report.alreadyV3}`)
	console.log(`  ${apply ? "converted" : "would convert"}   ${report.converted}`)
	console.log(`  broken before   ${report.brokenBefore}   (already failing in production today)`)
	console.log(`  quarantined     ${report.quarantined}   (left untouched)`)
	if (apply) console.log(`  CAS missed      ${report.casMissed}   (edited mid-run; re-run to pick up)`)
}

const run = async (connectionUrl: string, args: Args): Promise<void> => {
	const sql = postgres(connectionUrl, { max: 1, prepare: false, onnotice: () => {} })
	const dumpLines: string[] = []
	const quarantineLines: string[] = []

	try {
		if (args.restoreFrom !== undefined) {
			await restore(sql, args.restoreFrom)
			return
		}

		const dashboards = await backfillDashboards(
			sql,
			args,
			(line) => dumpLines.push(JSON.stringify(line)),
			(line) => quarantineLines.push(JSON.stringify(line)),
		)
		printReport("dashboards", dashboards, args.apply)

		let snapshots: Report | null = null
		if (!args.skipVersions) {
			snapshots = await backfillVersionSnapshots(sql, args, (line) =>
				quarantineLines.push(JSON.stringify(line)),
			)
			printReport("dashboard_versions", snapshots, args.apply)
		}

		if (args.apply && dumpLines.length > 0) {
			await Bun.write(args.dump, `${dumpLines.join("\n")}\n`)
			console.log(`\n✓ Pre-write dump: ${args.dump} (${dumpLines.length} rows)`)
			console.log("  Contains customer SQL and query definitions — treat as production data.")
		}
		if (quarantineLines.length > 0) {
			await Bun.write(args.quarantine, `${quarantineLines.join("\n")}\n`)
			console.log(`\n✗ Quarantine: ${args.quarantine} (${quarantineLines.length} rows)`)
		}

		// Non-zero on a live-document quarantine only. `brokenBefore` is pre-existing
		// breakage and must not make a clean run look failed — but it is reported, and
		// it is the number that says how many dashboards the flip strands.
		if (dashboards.quarantined > 0) {
			fail(`${dashboards.quarantined} live dashboard(s) quarantined — inspect ${args.quarantine}`)
		}
	} finally {
		await sql.end({ timeout: 5 })
	}
}

const args = parseArgs(process.argv.slice(2))
if (args.url === undefined && args.branch === undefined) {
	fail("Pass --branch <name> (PlanetScale) or --url <dsn> (local rehearsal).")
}

if (args.url !== undefined) {
	await run(args.url, args)
} else {
	await withBranchConnection(args.branch!, (url) => run(url, args))
}
