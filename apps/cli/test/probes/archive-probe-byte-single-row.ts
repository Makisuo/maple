// Probe: a single row that genuinely exceeds maxShardBytes must fail DISTINCTLY
// with a "single row exceeds maxShardBytes" message, not a generic
// "recalibrate". This is the only impassable case. Contract: exit 0 (PASS) when
// export fails with the distinct single-row message; exit nonzero (FAIL) when it
// aborts with a generic message or (worse) succeeds.
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-byte-single-row.ts

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { ArchiveProbe } from "../archive-probe-helpers"
import { archiveSignal } from "../../src/server/archives/signals"
import { exportSignalShards } from "../../src/server/archives/export"

const SCHEMA = `
CREATE DATABASE IF NOT EXISTS default;
CREATE TABLE IF NOT EXISTS default.traces (
  OrgId LowCardinality(String), Timestamp DateTime64(9), TraceId String, SpanId String, Body String
) ENGINE = MergeTree PARTITION BY toDate(Timestamp) ORDER BY (OrgId, SpanId);`

const h = ArchiveProbe.create("byte-single-row")
mkdirSync(h.outDir, { recursive: true })
const shardsDir = join(h.outDir, "shards")
mkdirSync(shardsDir, { recursive: true })

// One row whose uncompressed size (~2 MiB) far exceeds a 128 KiB bound.
const BYTE_BOUND = 128 * 1024

try {
	const db = h.openDb(SCHEMA)
	db.exec(
		`INSERT INTO traces SELECT 'org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 't0', 's0', randomString(2097152)`,
	)

	try {
		exportSignalShards(db, archiveSignal("traces"), "2026-06-29", shardsDir, {
			writerThreads: 1,
			rowGroupRows: 10_000,
			maxShardRows: 500_000,
			maxShardBytes: BYTE_BOUND,
		})
		h.fail("single oversized row was archived (should have failed distinctly)")
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		if (/single row exceeds maxShardBytes/i.test(msg)) {
			h.ok(`distinct single-row failure: ${msg.slice(0, 120)}`)
		}
		h.fail(`oversized single row failed with a non-distinct message: ${msg.slice(0, 160)}`)
	}
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
