// RED→GREEN probe (round 5): a row containing NULL nullable columns must STILL
// be value-sensitive in its NON-NULL columns. This is the reviewer's round-5
// finding: round-5's `isNull(c), c` passed a bare nullable value into
// cityHash64, and chDB returns NULL if ANY argument is NULL — collapsing the
// ENTIRE per-row hash. Two metrics_histogram datasets with NULL Min/Max but
// different Count/Sum/BucketCounts produced the identical digest.
//
// Contract: exit 0 (PASS) when the two datasets produce DIFFERENT digests;
// exit nonzero (FAIL) when they are equal (the bare-NULL collapse).
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-null-value-sensitivity.ts

import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { ArchiveProbe } from "../archive-probe-helpers"
import { archiveSignal } from "../../src/server/archives/signals"
import { exportSignalShards } from "../../src/server/archives/export"

// metrics_histogram carries Nullable(Float64) Min/Max, NULL when unset — the
// exact production shape that defeated the round-5 digest.
const SCHEMA = `CREATE DATABASE IF NOT EXISTS default;
CREATE TABLE IF NOT EXISTS default.metrics_histogram (
  OrgId LowCardinality(String), TimeUnix DateTime64(9), MetricName LowCardinality(String),
  Count UInt64, Sum Float64, BucketCounts Array(UInt64), ExplicitBounds Array(Float64),
  Flags UInt32, Min Nullable(Float64), Max Nullable(Float64), AggregationTemporality Int32
) ENGINE = MergeTree PARTITION BY toDate(TimeUnix) ORDER BY (OrgId, MetricName);`

const h = ArchiveProbe.create("null-value-sensitivity")
mkdirSync(h.outDir, { recursive: true })

const exportOnce = (db: ReturnType<typeof h.openDb>, suffix: string): string => {
	const dir = join(h.outDir, `shards-${suffix}`)
	mkdirSync(dir, { recursive: true })
	const written = exportSignalShards(db, archiveSignal("metrics_histogram"), "2026-06-29", dir, {
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
	// Dataset A: NULL Min/Max, Count=3, Sum=1.0, buckets [1,1,1].
	const dbA = h.openDb(SCHEMA, "db-a")
	dbA.exec(`INSERT INTO metrics_histogram (OrgId, TimeUnix, MetricName, Count, Sum, BucketCounts, ExplicitBounds, Flags, Min, Max, AggregationTemporality) VALUES
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'lat', 3, 1.0, [1,1,1], [0.0,1.0,5.0], 0, NULL, NULL, 0)`)
	const digestA = exportOnce(dbA, "A")
	dbA.close()

	// Dataset B: SAME schema, SAME row count (1), SAME event-time extrema, NULL
	// Min/Max — but DIFFERENT non-null values (Count=99, Sum=42.0, buckets [9,9,9]).
	// A value-sensitive digest must distinguish this from A.
	const dbB = h.openDb(SCHEMA, "db-b")
	dbB.exec(`INSERT INTO metrics_histogram (OrgId, TimeUnix, MetricName, Count, Sum, BucketCounts, ExplicitBounds, Flags, Min, Max, AggregationTemporality) VALUES
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'lat', 99, 42.0, [9,9,9], [9.0,10.0,50.0], 0, NULL, NULL, 0)`)
	const digestB = exportOnce(dbB, "B")
	dbB.close()

	if (digestA === digestB) {
		h.fail(
			`NULL-bearing rows with different non-null values produced identical digest ${digestA}; ` +
				`the digest passes a bare nullable value into cityHash64 and collapses the row hash`,
		)
	}
	h.ok(`NULL-bearing rows remain value-sensitive: digest A=${digestA} != B=${digestB}`)
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
