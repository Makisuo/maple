// Adversarial merge-injection probe for the static-snapshot part-interval plan.
//
// Reproduces the exact cross-check corruption scenario: two parts for the same
// hour, with an OPTIMIZE TABLE ... FINAL injected between shard exports via the
// afterShardValidated hook. With SYSTEM STOP MERGES in effect, the OPTIMIZE
// must be blocked (or harmless), and the exported shards must contain the exact
// source row set with no duplicates or omissions.
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/merge-injection-probe.ts

import { rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { Chdb } from "../src/server/chdb"
import { exportSignalShards } from "../src/server/archives/export"
import { archiveSignal } from "../src/server/archives/signals"

const SCHEMA = `
CREATE DATABASE IF NOT EXISTS default;
CREATE TABLE IF NOT EXISTS default.traces (
  OrgId LowCardinality(String), Timestamp DateTime64(9), TraceId String, SpanId String,
  ParentSpanId String, TraceState String, SpanName LowCardinality(String),
  SpanKind LowCardinality(String), ServiceName LowCardinality(String),
  StatusCode LowCardinality(String), StatusMessage String
) ENGINE = MergeTree ORDER BY (OrgId, ServiceName, SpanName, toDateTime(Timestamp));
`

const OUT = "/tmp/merge-injection-probe-out"
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const db = Chdb.open({ dataDir: "/tmp/merge-injection-probe-db", schemaSql: SCHEMA, bootstrapSchema: true })
rmSync("/tmp/merge-injection-probe-db", { recursive: true, force: true })
// Re-open after clearing (bootstrapSchema creates the schema on open).
const db2 = Chdb.open({ dataDir: "/tmp/merge-injection-probe-db", schemaSql: SCHEMA, bootstrapSchema: true })

// Insert two batches at the same UTC hour → two parts.
// Batch 1: IDs t4-t7. Batch 2: IDs t0-t3. (Out-of-order, like the cross-check.)
db2.exec(
	"INSERT INTO traces SELECT 'local', toDateTime64('2026-06-29 12:00:00.000', 9, 'UTC'), 't'||toString(number+4), 's'||toString(number+4), '', '', 'probe', 'Server', 'probe', 'Ok', '' FROM numbers(4)",
)
db2.exec(
	"INSERT INTO traces SELECT 'local', toDateTime64('2026-06-29 12:00:00.000', 9, 'UTC'), 't'||toString(number), 's'||toString(number), '', '', 'probe', 'Server', 'probe', 'Ok', '' FROM numbers(4)",
)

// Verify two parts exist.
const partsResult = db2.query(
	"SELECT count(DISTINCT _part) AS n FROM traces WHERE toDate(Timestamp,'UTC')='2026-06-29' AND toHour(Timestamp,'UTC')=12",
	"JSONEachRow",
)
console.log("parts before export:", partsResult.trim())

// The source set of IDs (sorted) that MUST appear in the archive.
const sourceIds = db2
	.query(
		"SELECT TraceId FROM traces WHERE toDate(Timestamp,'UTC')='2026-06-29' AND toHour(Timestamp,'UTC')=12 ORDER BY TraceId",
		"JSONEachRow",
	)
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l).TraceId as string)
	.sort()
console.log("source IDs:", sourceIds.join(","))

// Export with an OPTIMIZE injected between shards.
let optimizeFired = false
let optimizeError: string | null = null
const shardsDir = join(OUT, "shards")
mkdirSync(shardsDir, { recursive: true })

try {
	const written = exportSignalShards(db2, archiveSignal("traces"), "2026-06-29", shardsDir, {
		writerThreads: 1,
		rowGroupRows: 10_000,
		maxShardRows: 500_000,
		maxShardBytes: 256 * 1024 * 1024,
		afterShardValidated: (d, signal) => {
			// Inject an OPTIMIZE TABLE FINAL between shards.
			optimizeFired = true
			try {
				d.exec(`OPTIMIZE TABLE ${signal.name} FINAL`)
				console.log("  OPTIMIZE fired (not blocked by STOP MERGES)")
			} catch (e) {
				optimizeError = e instanceof Error ? e.message : String(e)
				console.log("  OPTIMIZE blocked by STOP MERGES:", optimizeError?.slice(0, 80))
			}
		},
	})
	console.log("shards written:", written.length)
	console.log("optimize fired:", optimizeFired, "blocked:", optimizeError !== null)

	// Read back all shard IDs via chDB file().
	const allIds: string[] = []
	for (const shard of written) {
		const rows = db2.query(
			`SELECT TraceId FROM file('${shard.path}', Parquet) ORDER BY TraceId`,
			"JSONEachRow",
		)
		for (const line of rows.trim().split("\n")) {
			if (line.trim()) allIds.push(JSON.parse(line).TraceId)
		}
	}
	allIds.sort()
	console.log("archived IDs:", allIds.join(","))

	// The corruption check: [5,6,7,8,5,6,7,8] under the old OFFSET approach.
	const sourceStr = sourceIds.join(",")
	const archivedStr = allIds.join(",")
	if (sourceStr !== archivedStr) {
		console.error(`CORRUPTION: source={${sourceStr}} archived={${archivedStr}}`)
		process.exit(1)
	}
	if (allIds.length !== 8) {
		console.error(`COUNT MISMATCH: expected 8, got ${allIds.length}`)
		process.exit(1)
	}
	const distinct = new Set(allIds).size
	if (distinct !== 8) {
		console.error(`DUPLICATES: ${allIds.length} rows but only ${distinct} distinct`)
		process.exit(1)
	}
	console.log("PASS: exact ID match [t0-t7], no duplicates, no omissions")
} catch (e) {
	console.error("EXPORT FAILED:", e instanceof Error ? e.message : String(e))
	process.exit(1)
} finally {
	db2.close()
	db.close()
	rmSync(OUT, { recursive: true, force: true })
	rmSync("/tmp/merge-injection-probe-db", { recursive: true, force: true })
}
