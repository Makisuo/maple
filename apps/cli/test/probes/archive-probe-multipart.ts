// Adversarial probe: multiple parts in one hour (out-of-order inserts) archive
// the exact source set with no duplicates or omissions. Contract: exit 0 (PASS)
// when 8 rows across 2 parts archive as the exact source set.
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-multipart.ts

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

const h = ArchiveProbe.create("multipart")
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

	const written = exportSignalShards(db, archiveSignal("traces"), "2026-06-29", shardsDir, {
		writerThreads: 1,
		rowGroupRows: 10_000,
		maxShardRows: 500_000,
		maxShardBytes: 256 * 1024 * 1024,
	})
	const archived: string[] = []
	for (const s of written) {
		for (const r of readRows(db.query(`SELECT TraceId FROM file('${s.path}', Parquet)`, "JSONEachRow")))
			archived.push(String(r.TraceId))
	}
	archived.sort()
	if (archived.join(",") !== sourceSet.join(",")) h.fail(`source [${sourceSet}] != archived [${archived}]`)
	if (archived.length !== 8) h.fail(`expected 8 rows got ${archived.length}`)
	if (new Set(archived).size !== 8) h.fail(`duplicates among ${archived}`)
	h.ok(`multi-part hour archived exact set [${archived}] (${written.length} shards)`)
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
