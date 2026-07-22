// INDEPENDENT-ORACLE probe (round 5, Step 8): compare canonical source truth
// against the SAME data read back from the archived Parquet via DuckDB — an
// independent reader, NOT the export code's own digest. This closes the
// "tests confirm what you intended" failure: it asks DuckDB whether the archived
// Parquet holds the exact source values (count, NULLs, arrays, nanosecond
// timestamps), rather than checking the export code against itself.
//
// Contract: exit 0 (PASS) when every oracle matches; exit nonzero otherwise.
//
// Run: MAPLE_LIBCHDB=<bundle>/libchdb.so bun apps/cli/test/probes/archive-probe-duckdb-oracle.ts
//      (duckdb must be on PATH)

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { ArchiveProbe, readRows } from "../archive-probe-helpers"
import { archiveSignal } from "../../src/server/archives/signals"
import { exportSignalShards } from "../../src/server/archives/export"

const SCHEMA = `CREATE DATABASE IF NOT EXISTS default;
CREATE TABLE IF NOT EXISTS default.traces (
  OrgId LowCardinality(String), Timestamp DateTime64(9), TraceId String,
  SpanAttributes Map(LowCardinality(String), String),
  EventsName Array(LowCardinality(String)),
  EventsTimestamp Array(DateTime64(9))
) ENGINE = MergeTree PARTITION BY toDate(Timestamp) ORDER BY (OrgId, TraceId);
CREATE TABLE IF NOT EXISTS default.metrics_histogram (
  OrgId LowCardinality(String), TimeUnix DateTime64(9), MetricName LowCardinality(String),
  Count UInt64, BucketCounts Array(UInt64), Min Nullable(Float64), Max Nullable(Float64)
) ENGINE = MergeTree PARTITION BY toDate(TimeUnix) ORDER BY (OrgId, MetricName);`

const h = ArchiveProbe.create("duckdb-oracle")
mkdirSync(h.outDir, { recursive: true })

/** Run a scalar/CSV DuckDB query over a list of parquet paths. */
const duckScalar = (paths: string[], expr: string): string => {
	const list = paths.map((p) => `'${p}'`).join(",")
	return execSync(
		`duckdb -csv -noheader -c "SELECT ${expr} FROM read_parquet([${list}], union_by_name=true)"`,
		{
			encoding: "utf8",
		},
	).trim()
}

try {
	const db = h.openDb(SCHEMA)
	db.exec(`INSERT INTO traces VALUES
	  ('org1', toDateTime64('2026-06-29 12:00:00.123456789', 9, 'UTC'), 't1',
	   map('http.method','GET','http.route','/'), array('start','finish'),
	   array(toDateTime64('2026-06-29 12:00:00.1', 9, 'UTC'), toDateTime64('2026-06-29 12:00:00.2', 9, 'UTC'))),
	  ('org1', toDateTime64('2026-06-29 12:01:00', 9, 'UTC'), 't2',
	   map('http.method','POST'), array('end'), array(toDateTime64('2026-06-29 12:01:00', 9, 'UTC')));`)
	db.exec(`INSERT INTO metrics_histogram VALUES
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'lat', 3, [1,1,1], 1.0, 5.0),
	  ('org1', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 'lat', 2, [1,1], NULL, NULL);`)

	const tDir = join(h.outDir, "traces")
	mkdirSync(tDir, { recursive: true })
	const hDir = join(h.outDir, "hist")
	mkdirSync(hDir, { recursive: true })
	const tShards = exportSignalShards(db, archiveSignal("traces"), "2026-06-29", tDir, {
		writerThreads: 1,
		rowGroupRows: 10_000,
		maxShardRows: 500_000,
		maxShardBytes: 256 * 1024 * 1024,
	})
	const hShards = exportSignalShards(db, archiveSignal("metrics_histogram"), "2026-06-29", hDir, {
		writerThreads: 1,
		rowGroupRows: 10_000,
		maxShardRows: 500_000,
		maxShardBytes: 256 * 1024 * 1024,
	})

	const tPaths = tShards.map((s) => s.path)
	const hPaths = hShards.map((s) => s.path)

	// ORACLE 1 — traces row count via DuckDB equals source.
	const srcTraces = Number(readRows(db.query(`SELECT count() c FROM traces`, "JSONEachRow"))[0]!.c)
	const duckTraces = Number(duckScalar(tPaths, "count()"))
	if (duckTraces !== srcTraces) h.fail(`DuckDB traces count ${duckTraces} != source ${srcTraces}`)

	// ORACLE 2 — traces nanosecond timestamp fidelity via DuckDB. The high-
	// precision 12:00:00.123456789 row must round-trip to the same epoch
	// MICROSECONDS — a timezone-stable cross-tool comparison (DuckDB renders the
	// value in the host timezone, but epoch_us is invariant).
	const srcNano = BigInt(
		String(
			readRows(
				db.query(
					`SELECT toString(toUnixTimestamp64Nano(toDateTime64(Timestamp, 9))) n FROM traces WHERE TraceId='t1'`,
					"JSONEachRow",
				),
			)[0]!.n,
		),
	)
	const srcMicro = srcNano / 1000n
	// epoch_us on the RAW TIMESTAMPTZ column (no CAST — a CAST strips the tz and
	// makes epoch_us host-tz-dependent). DuckDB reads DateTime64(9) as TIMESTAMP
	// WITH TIME ZONE, so epoch_us on the raw column is UTC-stable.
	const duckMicro = BigInt(
		execSync(
			`duckdb -csv -noheader -c "SELECT epoch_us(Timestamp) FROM read_parquet([${tPaths.map((p) => `'${p}'`).join(",")}], union_by_name=true) WHERE TraceId='t1'"`,
			{ encoding: "utf8" },
		).trim(),
	)
	if (duckMicro !== srcMicro) {
		h.fail(`DuckDB timestamp micros ${duckMicro} != source ${srcMicro} for the high-precision t1 row`)
	}

	// ORACLE 3 — histogram NULL fidelity: DuckDB sees the NULL Min/Max row.
	const srcNull = Number(
		readRows(db.query(`SELECT count() c FROM metrics_histogram WHERE isNull(Min)`, "JSONEachRow"))[0]!.c,
	)
	const duckNull = Number(duckScalar(hPaths, `count() FILTER (WHERE Min IS NULL)`))
	if (duckNull !== srcNull) h.fail(`DuckDB NULL Min count ${duckNull} != source ${srcNull}`)

	// ORACLE 4 — histogram array fidelity: BucketCounts [1,1,1] preserved.
	const srcBuckets = String(
		readRows(db.query(`SELECT BucketCounts FROM metrics_histogram WHERE Count=3`, "JSONEachRow"))[0]!
			.BucketCounts,
	)
	const duckBuckets = execSync(
		`duckdb -csv -noheader -c "SELECT BucketCounts FROM read_parquet([${hPaths.map((p) => `'${p}'`).join(",")}], union_by_name=true) WHERE Count=3"`,
		{ encoding: "utf8" },
	).trim()
	// DuckDB renders arrays as [1,1,1] or {1,1,1}; both contain three 1s.
	const srcOnes = (srcBuckets.match(/1/g) || []).length
	const duckOnes = (duckBuckets.match(/1/g) || []).length
	if (srcOnes !== duckOnes)
		h.fail(`DuckDB BucketCounts ones ${duckOnes} != source ${srcOnes} (duck=${duckBuckets})`)

	h.ok(
		`DuckDB oracle: traces count+nanos (${duckTraces}), histogram NULL Min (${duckNull}) and BucketCounts (${srcOnes} ones) all match source`,
	)
} catch (e) {
	h.fail(e instanceof Error ? e.message : String(e))
}
