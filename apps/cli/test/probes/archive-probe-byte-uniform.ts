// Probe: uniform wide high-entropy rows split by the byte bound, each shard <=
// the bound, exact source set. This is the round-4 case that already passed;
// relocated hermetic. Contract: exit 0 (PASS) when uniform wide rows split into
// multiple byte-bounded shards with the exact source set.
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-byte-uniform.ts

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { ArchiveProbe, firstRow, readRows } from "../archive-probe-helpers"
import { archiveSignal } from "../../src/server/archives/signals"
import { exportSignalShards } from "../../src/server/archives/export"

const SCHEMA = `
CREATE DATABASE IF NOT EXISTS default;
CREATE TABLE IF NOT EXISTS default.traces (
  OrgId LowCardinality(String), Timestamp DateTime64(9), TraceId String, SpanId String, Body String
) ENGINE = MergeTree PARTITION BY toDate(Timestamp) ORDER BY (OrgId, SpanId);`

const h = ArchiveProbe.create("byte-uniform")
mkdirSync(h.outDir, { recursive: true })
const shardsDir = join(h.outDir, "shards")
mkdirSync(shardsDir, { recursive: true })

const BYTE_BOUND = 512 * 1024

try {
	const db = h.openDb(SCHEMA)
	db.exec(
		`INSERT INTO traces SELECT 'org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 't'||toString(number), 's'||toString(number), randomString(60000) FROM numbers(30)`,
	)

	const written = exportSignalShards(db, archiveSignal("traces"), "2026-06-29", shardsDir, {
		writerThreads: 1,
		rowGroupRows: 10_000,
		maxShardRows: 500_000,
		maxShardBytes: BYTE_BOUND,
	})
	if (written.length <= 1)
		h.fail(`byte-aware planner produced only ${written.length} shard for a ~1.8 MiB hour at 512 KiB`)
	for (const s of written) {
		const u = Number(
			firstRow(
				db.query(
					`SELECT total_uncompressed_size u FROM file('${s.path}', ParquetMetadata)`,
					"JSONEachRow",
				),
			)?.u ?? 0,
		)
		if (u > BYTE_BOUND) h.fail(`shard ${s.name} uncompressed ${u} > ${BYTE_BOUND}`)
	}
	const archived = readRows(db.query(`SELECT TraceId FROM traces ORDER BY TraceId`, "JSONEachRow"))
		.map((r) => String(r.TraceId))
		.sort()
	const got: string[] = []
	for (const s of written)
		for (const r of readRows(db.query(`SELECT TraceId FROM file('${s.path}', Parquet)`, "JSONEachRow")))
			got.push(String(r.TraceId))
	got.sort()
	if (got.join(",") !== archived.join(",")) h.fail(`source != archived`)
	h.ok(`uniform wide rows split into ${written.length} byte-bounded shards, exact set`)
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
