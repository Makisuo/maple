// RED-BASELINE probe (round 5): same-typed column SWAP must change the digest.
//
// This faithfully reproduces the reviewer's round-4 CRITICAL finding: the
// round-4 digest is `sum(toUInt64(cityHash64(c_i)))` across columns, which is
// COMMUTATIVE across columns. Swapping two same-typed Map columns
// (SpanAttributes <-> ResourceAttributes) — exchanging which VALUES sit under
// which column name — preserves the sum exactly while corrupting every row.
// Count and time extrema are also preserved, so no other check catches it.
//
// NOTE the distinction the prior (buggy) probe got wrong: this is a COLUMN swap
// (column A's values move under column B's name and vice versa), NOT a value
// swap within one column. A value swap IS detected by a per-column hash; a
// column swap is NOT, because the per-column hashes are summed independently.
//
// Contract: exit 0 (PASS) when the column-swapped export's digest DIFFERS from
// the original's; exit nonzero (FAIL) when equal (the commutative bug).
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-digest-column-swap.ts

import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { ArchiveProbe } from "../archive-probe-helpers"
import { archiveSignal } from "../../src/server/archives/signals"
import { exportSignalShards } from "../../src/server/archives/export"

// Two Map columns of the SAME type — the precondition for the commutative
// collision. (logs/traces/metrics all carry several Map(LowCardinality(String),
// String) columns, so this is a production-realistic shape.)
const SCHEMA = `
CREATE DATABASE IF NOT EXISTS default;
CREATE TABLE IF NOT EXISTS default.traces (
  OrgId LowCardinality(String), Timestamp DateTime64(9), TraceId String, SpanId String,
  SpanAttributes Map(LowCardinality(String), String),
  ResourceAttributes Map(LowCardinality(String), String)
) ENGINE = MergeTree PARTITION BY toDate(Timestamp) ORDER BY (OrgId, SpanId);`

const h = ArchiveProbe.create("digest-column-swap")
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
	// Original: value X under SpanAttributes, value Y under ResourceAttributes.
	const dbA = h.openDb(SCHEMA, "db-a")
	dbA.exec(`INSERT INTO traces VALUES
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'tid1', 's1', map('k','X'), map('k','Y')),
	  ('org1', toDateTime64('2026-06-29 12:01:00', 9, 'UTC'), 'tid2', 's2', map('k','X2'), map('k','Y2'))`)
	const origDigest = exportOnce(dbA, "orig")
	dbA.close()

	// Column swap: the SAME value SETS, but X and Y are EXCHANGED between the two
	// same-typed Map columns. Span now holds Y, Resource now holds X. Count and
	// time extrema are identical; the per-column value sets are identical; only
	// the column<->value BINDING changed. A commutative per-column-sum digest
	// (cityHash64(c_i) summed across i) cannot distinguish this from the original.
	// This is the reviewer's exact CRITICAL finding.
	const dbB = h.openDb(SCHEMA, "db-b")
	dbB.exec(`INSERT INTO traces VALUES
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'tid1', 's1', map('k','Y'), map('k','X')),
	  ('org1', toDateTime64('2026-06-29 12:01:00', 9, 'UTC'), 'tid2', 's2', map('k','Y2'), map('k','X2'))`)
	const swapDigest = exportOnce(dbB, "swap")
	dbB.close()

	if (origDigest === swapDigest) {
		h.fail(
			`COLUMN-SWAP ACCEPTED: original digest == swapped digest (${origDigest}); the digest is commutative across same-typed columns and cannot detect a column<->value exchange`,
		)
	}
	h.ok(`column swap detected: ${origDigest} != ${swapDigest}`)
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
