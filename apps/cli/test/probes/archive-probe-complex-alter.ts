// Probe: an altered complex value with identical count and time extrema must
// change the digest. The round-4 per-column sum is value-sensitive for a single
// column change (this passed in round 4); the round-5 multiset must preserve it.
// Contract: exit 0 (PASS) when the altered export's digest DIFFERS.
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-complex-alter.ts

import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { ArchiveProbe } from "../archive-probe-helpers"
import { archiveSignal } from "../../src/server/archives/signals"
import { exportSignalShards } from "../../src/server/archives/export"

const SCHEMA = `
CREATE DATABASE IF NOT EXISTS default;
CREATE TABLE IF NOT EXISTS default.traces (
  OrgId LowCardinality(String), Timestamp DateTime64(9), TraceId String,
  SpanAttributes Map(LowCardinality(String), String)
) ENGINE = MergeTree PARTITION BY toDate(Timestamp) ORDER BY (OrgId, TraceId);`

const h = ArchiveProbe.create("complex-alter")
mkdirSync(h.outDir, { recursive: true })

const exportOnce = (db: ReturnType<typeof h.openDb>, suffix: string): string => {
	const dir = join(h.outDir, `shards-${suffix}`)
	mkdirSync(dir, { recursive: true })
	const written = exportSignalShards(db, archiveSignal("traces"), "2026-06-29", dir, {
		writerThreads: 1,
		rowGroupRows: 10_000,
		maxShardRows: 500_000,
		maxShardBytes: 256 * 1024 * 1024,
	})
	rmSync(dir, { recursive: true, force: true })
	if (written.length !== 1) h.fail(`expected 1 shard for ${suffix}, got ${written.length}`)
	return written[0]!.complexDigest
}

try {
	const dbA = h.openDb(SCHEMA, "db-a")
	dbA.exec(`INSERT INTO traces VALUES
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'tid1', map('http.method','GET','http.route','/')),
	  ('org1', toDateTime64('2026-06-29 12:01:00', 9, 'UTC'), 'tid2', map('http.method','POST'))`)
	const origDigest = exportOnce(dbA, "orig")
	dbA.close()

	const dbB = h.openDb(SCHEMA, "db-b")
	dbB.exec(`INSERT INTO traces VALUES
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'tid1', map('http.method','GETTTTTTT','http.route','/')),
	  ('org1', toDateTime64('2026-06-29 12:01:00', 9, 'UTC'), 'tid2', map('http.method','POST'))`)
	const altDigest = exportOnce(dbB, "alt")
	dbB.close()

	if (origDigest === altDigest) h.fail(`altered complex value produced same digest (${origDigest})`)
	h.ok(`altered complex value detected: ${origDigest} != ${altDigest}`)
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
