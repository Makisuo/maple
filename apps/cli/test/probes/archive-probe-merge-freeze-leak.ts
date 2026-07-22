// Adversarial probe: merge-freeze leak on mid-export failure. A failure after
// SYSTEM STOP MERGES must still restart merges. Contract: exit 0 (PASS) when
// merges are confirmed restarted (a later OPTIMIZE is NOT rejected with code
// 236) after a forced mid-export failure.
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-merge-freeze-leak.ts

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ArchiveProbe } from "../archive-probe-helpers"
import { archiveSignal } from "../../src/server/archives/signals"
import { exportSignalShards } from "../../src/server/archives/export"

const SCHEMA = `
CREATE DATABASE IF NOT EXISTS default;
CREATE TABLE IF NOT EXISTS default.traces (
  OrgId LowCardinality(String), Timestamp DateTime64(9), TraceId String, SpanId String
) ENGINE = MergeTree PARTITION BY toDate(Timestamp) ORDER BY (OrgId, SpanId);`

const h = ArchiveProbe.create("merge-freeze-leak")
mkdirSync(h.outDir, { recursive: true })
const shardsDir = join(h.outDir, "shards")
mkdirSync(shardsDir, { recursive: true })

try {
	const db = h.openDb(SCHEMA)
	db.exec(
		`INSERT INTO traces SELECT 'org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 't'||toString(number), 's'||toString(number) FROM numbers(4)`,
	)
	db.exec(
		`INSERT INTO traces SELECT 'org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 't'||toString(number+4), 's'||toString(number+4) FROM numbers(4)`,
	)

	// Pre-create the first shard path the planner will target, forcing a mid-
	// export "already exists" throw AFTER STOP MERGES has fired.
	writeFileSync(join(shardsDir, "12-0000.parquet"), "poison")

	let threw = false
	try {
		exportSignalShards(db, archiveSignal("traces"), "2026-06-29", shardsDir, {
			writerThreads: 1,
			rowGroupRows: 10_000,
			maxShardRows: 2,
			maxShardBytes: 256 * 1024 * 1024,
		})
	} catch {
		threw = true
	}
	if (!threw) h.fail("export did not throw on pre-existing shard")

	// Critical assertion: merges must have been RESTARTED. An OPTIMIZE now must
	// NOT be rejected with code 236.
	let optimizeErr = ""
	try {
		db.exec(
			`INSERT INTO traces VALUES ('org1', toDateTime64('2026-06-29 13:00:00', 9, 'UTC'), 'x1', 'x1')`,
		)
		db.exec(`OPTIMIZE TABLE traces FINAL`)
	} catch (e) {
		optimizeErr = e instanceof Error ? e.message : String(e)
	}
	if (optimizeErr.includes("236"))
		h.fail(`merges remained stopped after failure: ${optimizeErr.slice(0, 120)}`)
	h.ok(`merges restarted after mid-export failure (optimize error: "${optimizeErr.slice(0, 60)}")`)
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
