// RED-BASELINE probe (round 5): heterogeneous byte widths must refine, not
// abort. 300 narrow ordered rows followed by 10 wide (60 KiB high-entropy) rows
// under a 128 KiB byte bound: a sample-based plan using the first 256 rows
// underestimates and then aborts on the wide tail. Authoritative refinement must
// split the wide region until every shard meets both bounds.
// Contract: exit 0 (PASS) when every shard's actual uncompressed size <= the
// bound; exit nonzero (FAIL) when export aborts with "recalibrate"/"exceeds".
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-byte-heterogeneous.ts

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { ArchiveProbe, firstRow } from "../archive-probe-helpers"
import { archiveSignal } from "../../src/server/archives/signals"
import { exportSignalShards } from "../../src/server/archives/export"

const SCHEMA = `
CREATE DATABASE IF NOT EXISTS default;
CREATE TABLE IF NOT EXISTS default.traces (
  OrgId LowCardinality(String), Timestamp DateTime64(9), TraceId String, SpanId String, Body String
) ENGINE = MergeTree PARTITION BY toDate(Timestamp) ORDER BY (OrgId, SpanId);`

const h = ArchiveProbe.create("byte-heterogeneous")
mkdirSync(h.outDir, { recursive: true })
const shardsDir = join(h.outDir, "shards")
mkdirSync(shardsDir, { recursive: true })

const BYTE_BOUND = 128 * 1024

try {
	const db = h.openDb(SCHEMA)
	// 300 narrow rows first (so the 256-row probe samples only narrow data),
	// then 10 wide high-entropy rows.
	db.exec(
		`INSERT INTO traces SELECT 'org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'n'||toString(number), 'sn'||toString(number), 'x' FROM numbers(300)`,
	)
	db.exec(
		`INSERT INTO traces SELECT 'org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'w'||toString(number), 'sw'||toString(number), randomString(60000) FROM numbers(10)`,
	)

	const written = exportSignalShards(db, archiveSignal("traces"), "2026-06-29", shardsDir, {
		writerThreads: 1,
		rowGroupRows: 10_000,
		maxShardRows: 500_000,
		maxShardBytes: BYTE_BOUND,
	})
	// Every shard's actual uncompressed size must be <= the bound.
	let worst = 0
	for (const s of written) {
		const u = Number(
			firstRow(
				db.query(
					`SELECT total_uncompressed_size u FROM file('${s.path}', ParquetMetadata)`,
					"JSONEachRow",
				),
			)?.u ?? 0,
		)
		if (u > worst) worst = u
		if (u > BYTE_BOUND) h.fail(`shard ${s.name} uncompressed ${u} > bound ${BYTE_BOUND}`)
	}
	h.ok(
		`heterogeneous widths refined: ${written.length} shards, each <= ${BYTE_BOUND} bytes (worst ${worst})`,
	)
} catch (e) {
	const msg = e instanceof Error ? e.message : String(e)
	if (/exceeds|maxShardBytes|recalibrate/i.test(msg)) {
		h.fail(`heterogeneous export aborted instead of refining: ${msg.slice(0, 160)}`)
	}
	h.fail(msg)
}
