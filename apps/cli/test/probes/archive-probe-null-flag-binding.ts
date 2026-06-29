// RED→GREEN probe (round-5 repair): NULL must NOT collide with a real string
// value. The round-5-repair digest used a sentinel string for NULL; a real
// Nullable(String) value equal to that sentinel produced the same digest as an
// actual NULL (verified collision). The documented invariant is an EXPLICIT
// isNull flag, so NULL-ness is never conflated with a value.
//
// Contract: exit 0 (PASS) when a NULL and the sentinel string produce DIFFERENT
// digests; exit nonzero (FAIL) when they collide.
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-null-flag-binding.ts

import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { ArchiveProbe } from "../archive-probe-helpers"
import { archiveSignal } from "../../src/server/archives/signals"
import { exportSignalShards } from "../../src/server/archives/export"

// A traces-shaped table with an added Nullable(String) column to expose the
// NULL-vs-sentinel-string collision generically.
const SCHEMA = `CREATE DATABASE IF NOT EXISTS default;
CREATE TABLE IF NOT EXISTS default.traces (
  OrgId LowCardinality(String), Timestamp DateTime64(9), TraceId String, SpanId String,
  Note Nullable(String)
) ENGINE = MergeTree PARTITION BY toDate(Timestamp) ORDER BY (OrgId, SpanId);`

const h = ArchiveProbe.create("null-flag-binding")
mkdirSync(h.outDir, { recursive: true })

const exportOnce = (db: ReturnType<typeof h.openDb>, suffix: string, noteExpr: string): string => {
	const dir = join(h.outDir, `shards-${suffix}`)
	mkdirSync(dir, { recursive: true })
	db.exec(
		`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, Note) ` +
			`VALUES ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 't1', 's1', ${noteExpr})`,
	)
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
	// NULL Note.
	const dbA = h.openDb(SCHEMA, "db-a")
	const digestNull = exportOnce(dbA, "null", "NULL")
	dbA.close()

	// A real string value that, under a sentinel-only digest, would collide with
	// NULL. Use a value that a sentinel might be (and that '\x00NULL' represents).
	const dbB = h.openDb(SCHEMA, "db-b")
	const digestString = exportOnce(dbB, "string", "'\\x00NULL'")
	dbB.close()

	if (digestNull === digestString) {
		h.fail(
			`NULL collided with a real Nullable(String) value: digest ${digestNull}; ` +
				`the digest must bind an explicit isNull flag, not a sentinel string`,
		)
	}
	h.ok(`explicit NULL flag distinguishes NULL from a sentinel string: ${digestNull} != ${digestString}`)
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
