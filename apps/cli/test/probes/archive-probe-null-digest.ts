// Probe: a NULL in any column (histogram Min/Max) must NOT collapse the digest
// to empty/NULL. Round 4 handled this with per-column sentinels; round 5 must
// preserve it. Contract: exit 0 (PASS) when the export succeeds with a non-empty
// digest for a row containing NULL columns.
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-null-digest.ts

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { ArchiveProbe } from "../archive-probe-helpers"
import { archiveSignal } from "../../src/server/archives/signals"
import { exportSignalShards } from "../../src/server/archives/export"

const SCHEMA = `
CREATE DATABASE IF NOT EXISTS default;
CREATE TABLE IF NOT EXISTS default.metrics_histogram (
  OrgId LowCardinality(String), TimeUnix DateTime64(9), MetricName LowCardinality(String),
  Count UInt64, Sum Float64, BucketCounts Array(UInt64), ExplicitBounds Array(Float64),
  Flags UInt32, Min Nullable(Float64), Max Nullable(Float64), AggregationTemporality Int32
) ENGINE = MergeTree PARTITION BY toDate(TimeUnix) ORDER BY (OrgId, MetricName);`

const h = ArchiveProbe.create("null-digest")
mkdirSync(h.outDir, { recursive: true })
const shardsDir = join(h.outDir, "shards")
mkdirSync(shardsDir, { recursive: true })

try {
	const db = h.openDb(SCHEMA)
	// Both NULL Min/Max (the round-4 collapse case).
	db.exec(`INSERT INTO metrics_histogram (OrgId, TimeUnix, MetricName, Count, Sum, BucketCounts, ExplicitBounds, Flags, Min, Max, AggregationTemporality) VALUES
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'lat', 1, 1.0, [1], [0.0], 0, NULL, NULL, 0)`)

	const written = exportSignalShards(db, archiveSignal("metrics_histogram"), "2026-06-29", shardsDir, {
		writerThreads: 1,
		rowGroupRows: 10_000,
		maxShardRows: 500_000,
		maxShardBytes: 256 * 1024 * 1024,
	})
	const digest = written[0]!.complexDigest
	if (!digest || digest.length === 0) h.fail(`NULL columns collapsed digest to empty: '${digest}'`)
	h.ok(`NULL columns did not collapse digest: ${digest}`)
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
