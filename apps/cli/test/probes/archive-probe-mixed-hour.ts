// Adversarial probe: mixed-hour non-contiguous matching offsets must archive
// exactly. The round-3 part planner assumed filtered offsets were contiguous and
// selected cross-hour rows. Contract: exit 0 (PASS) when the hour-12 rows
// {tid0,tid9} (offsets 0 and 9, with hour-13 at offsets 1..8) archive exactly
// with no cross-hour bleed and the full day's source set is archived once.
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-mixed-hour.ts

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { ArchiveProbe, firstRow, readRows } from "../archive-probe-helpers"
import { archiveSignal } from "../../src/server/archives/signals"
import { exportSignalShards } from "../../src/server/archives/export"

const SCHEMA = `
CREATE DATABASE IF NOT EXISTS default;
CREATE TABLE IF NOT EXISTS default.traces (
  OrgId LowCardinality(String), Timestamp DateTime64(9), TraceId String, SpanId String
) ENGINE = MergeTree PARTITION BY toDate(Timestamp) ORDER BY (OrgId, SpanId);`

const h = ArchiveProbe.create("mixed-hour")
mkdirSync(h.outDir, { recursive: true })
const shardsDir = join(h.outDir, "shards")
mkdirSync(shardsDir, { recursive: true })

try {
	const db = h.openDb(SCHEMA)
	// ORDER BY (OrgId, SpanId): hour-12 occupies non-contiguous offsets 0 and 9,
	// hour-13 fills 1..8.
	db.exec(`INSERT INTO traces SELECT 'org1',
    multiIf(toUInt64(SpanId) IN (0,9),
      toDateTime64('2026-06-29 12:00:00', 9, 'UTC'),
      toDateTime64('2026-06-29 13:00:00', 9, 'UTC')) AS Timestamp,
    'tid' || SpanId, SpanId
    FROM (SELECT toString(number) AS SpanId FROM numbers(10))`)

	const written = exportSignalShards(db, archiveSignal("traces"), "2026-06-29", shardsDir, {
		writerThreads: 1,
		rowGroupRows: 10_000,
		maxShardRows: 500_000,
		maxShardBytes: 256 * 1024 * 1024,
	})

	// Every source row across the whole day must be archived exactly once, and
	// each shard must contain only its own hour (no cross-hour bleed).
	const sourceSet = readRows(
		db.query(
			`SELECT TraceId FROM traces WHERE toDate(Timestamp,'UTC')='2026-06-29' ORDER BY TraceId`,
			"JSONEachRow",
		),
	)
		.map((r) => String(r.TraceId))
		.sort()
	const archived: Array<{ id: string; hour: number }> = []
	for (const s of written) {
		const shardHour = Number(s.name.slice(0, 2))
		for (const r of readRows(
			db.query(
				`SELECT TraceId, toHour(Timestamp,'UTC') h FROM file('${s.path}', Parquet)`,
				"JSONEachRow",
			),
		)) {
			if (Number(r.h) !== shardHour)
				h.fail(`shard ${s.name} (hour ${shardHour}) contains hour-${r.h} row ${r.TraceId}`)
			archived.push({ id: String(r.TraceId), hour: Number(r.h) })
		}
	}
	const archivedSet = archived.map((a) => a.id).sort()
	if (archivedSet.join(",") !== sourceSet.join(","))
		h.fail(`source [${sourceSet}] != archived [${archivedSet}]`)
	if (new Set(archivedSet).size !== archivedSet.length) h.fail(`duplicate rows in archive`)

	const hour12 = written.find((s) => s.name.startsWith("12-"))
	if (!hour12) h.fail("no hour-12 shard produced")
	void firstRow
	h.ok(
		`mixed-hour non-contiguous offsets archived exactly; hour-12 in ${hour12!.name}, ${written.length} shards`,
	)
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
