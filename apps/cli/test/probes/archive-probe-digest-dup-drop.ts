// RED-BASELINE probe (round 5): duplicate-one/drop-another (equal-count pair)
// must be detected. Duplicate row A and drop row B where the total count is
// unchanged and the time extrema are unchanged. A multiset digest that
// preserves duplicates detects this; a count-only or sum digest does not.
// Contract: exit 0 (PASS) when the dup/drop export's digest DIFFERS.
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-digest-dup-drop.ts

import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { ArchiveProbe } from "../archive-probe-helpers"
import { archiveSignal } from "../../src/server/archives/signals"
import { exportSignalShards } from "../../src/server/archives/export"

const SCHEMA = `
CREATE DATABASE IF NOT EXISTS default;
CREATE TABLE IF NOT EXISTS default.traces (
  OrgId LowCardinality(String), Timestamp DateTime64(9), TraceId String, SpanId String,
  SpanAttributes Map(LowCardinality(String), String)
) ENGINE = MergeTree PARTITION BY toDate(Timestamp) ORDER BY (OrgId, SpanId);`

const h = ArchiveProbe.create("digest-dup-drop")
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
	// Original: two distinct rows.
	const dbA = h.openDb(SCHEMA, "db-a")
	dbA.exec(`INSERT INTO traces VALUES
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'tid1', 's1', map('k','AAA')),
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'tid2', 's2', map('k','BBB'))`)
	const origDigest = exportOnce(dbA, "orig")
	dbA.close()

	// Dup/drop: duplicate tid1 (AAA) twice and drop tid2 (BBB). Count stays 2,
	// time extrema stay identical. A duplicate-preserving multiset digest differs.
	const dbB = h.openDb(SCHEMA, "db-b")
	dbB.exec(`INSERT INTO traces VALUES
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'tid1', 's1', map('k','AAA')),
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'tid1', 's1', map('k','AAA'))`)
	const dupDigest = exportOnce(dbB, "dup")
	dbB.close()

	if (origDigest === dupDigest) {
		h.fail(
			`DUP/DROP ACCEPTED: original digest == dup/drop digest (${origDigest}); the digest cannot detect a duplicate-one/drop-another equal-count transform`,
		)
	}
	h.ok(`dup/drop detected: ${origDigest} != ${dupDigest}`)
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
