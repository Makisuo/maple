// RED-BASELINE probe (round 5): cross-row value reassociation must be detected.
// Move one row's map value to another row (and vice versa), preserving the row
// count and the time extrema exactly. A row-commutative digest (sum of per-row
// hashes) cannot detect this. Contract: exit 0 (PASS) when the reassociated
// export's digest DIFFERS; exit nonzero (FAIL) when equal (the bug).
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-digest-row-swap.ts

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

const h = ArchiveProbe.create("digest-row-swap")
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
	// Original: two rows with distinct map values, same hour.
	const dbA = h.openDb(SCHEMA, "db-a")
	dbA.exec(`INSERT INTO traces VALUES
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'tid1', 's1', map('k','AAA')),
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'tid2', 's2', map('k','BBB'))`)
	const origDigest = exportOnce(dbA, "orig")
	dbA.close()

	// Reassociated: swap the map VALUES between the two rows. Count and time
	// extrema are identical; only the row<->value association changed.
	const dbB = h.openDb(SCHEMA, "db-b")
	dbB.exec(`INSERT INTO traces VALUES
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'tid1', 's1', map('k','BBB')),
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'tid2', 's2', map('k','AAA'))`)
	const swapDigest = exportOnce(dbB, "swap")
	dbB.close()

	if (origDigest === swapDigest) {
		h.fail(
			`ROW-VALUE-SWAP ACCEPTED: original digest == swapped digest (${origDigest}); the digest cannot detect cross-row value reassociation`,
		)
	}
	h.ok(`cross-row value reassociation detected: ${origDigest} != ${swapDigest}`)
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
