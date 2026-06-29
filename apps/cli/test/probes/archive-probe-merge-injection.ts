// Adversarial probe: an OPTIMIZE TABLE FINAL injected between shard exports is
// blocked by SYSTEM STOP MERGES, and the exported shards contain the exact
// source set. Contract: exit 0 (PASS) when OPTIMIZE is blocked (code 236) every
// time and the archived IDs exactly equal the source IDs.
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-merge-injection.ts

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { ArchiveProbe, readRows } from "../archive-probe-helpers"
import { archiveSignal } from "../../src/server/archives/signals"
import { exportSignalShards } from "../../src/server/archives/export"

const SCHEMA = `
CREATE DATABASE IF NOT EXISTS default;
CREATE TABLE IF NOT EXISTS default.traces (
  OrgId LowCardinality(String), Timestamp DateTime64(9), TraceId String, SpanId String
) ENGINE = MergeTree PARTITION BY toDate(Timestamp) ORDER BY (OrgId, SpanId);`

const h = ArchiveProbe.create("merge-injection")
mkdirSync(h.outDir, { recursive: true })
const shardsDir = join(h.outDir, "shards")
mkdirSync(shardsDir, { recursive: true })

try {
	const db = h.openDb(SCHEMA)
	db.exec(
		`INSERT INTO traces SELECT 'org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 't'||toString(number+4), 's'||toString(number+4) FROM numbers(4)`,
	)
	db.exec(
		`INSERT INTO traces SELECT 'org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 't'||toString(number), 's'||toString(number) FROM numbers(4)`,
	)

	const sourceSet = readRows(
		db.query(
			`SELECT TraceId FROM traces WHERE toHour(Timestamp,'UTC')=12 ORDER BY TraceId`,
			"JSONEachRow",
		),
	)
		.map((r) => String(r.TraceId))
		.sort()

	let blocked = 0
	let leaked = 0
	const written = exportSignalShards(db, archiveSignal("traces"), "2026-06-29", shardsDir, {
		writerThreads: 1,
		rowGroupRows: 10_000,
		maxShardRows: 2,
		maxShardBytes: 256 * 1024 * 1024,
		afterShardValidated: (d, signal) => {
			try {
				d.exec(`OPTIMIZE TABLE ${signal.name} FINAL`)
				leaked++
			} catch {
				blocked++
			}
		},
	})
	if (leaked > 0) h.fail(`OPTIMIZE was NOT blocked ${leaked} time(s)`)
	const archived: string[] = []
	for (const s of written) {
		for (const r of readRows(db.query(`SELECT TraceId FROM file('${s.path}', Parquet)`, "JSONEachRow")))
			archived.push(String(r.TraceId))
	}
	archived.sort()
	if (archived.join(",") !== sourceSet.join(",")) h.fail(`source [${sourceSet}] != archived [${archived}]`)
	h.ok(`injected OPTIMIZE blocked ${blocked}x; exact set archived [${archived}] (${written.length} shards)`)
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
