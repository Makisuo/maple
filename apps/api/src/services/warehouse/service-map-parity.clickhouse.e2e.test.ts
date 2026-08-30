// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// Raw-vs-rollup parity for the service-map tiers.
//
// Every service-map edge query reconstructs its window from two sources: exact
// raw rows for the two PARTIAL hours at the ends, and an hourly rollup for the
// whole-hour interior. Correctness rests entirely on those tiers TILING the
// window — covering it exactly once, with no gap and no overlap.
//
// That property cannot be checked by reading the SQL, and it is not hypothetical
// here. Until 2026-08-30 the DB-edge pair floored the interior to
// `toStartOfHour(startTime)` while its raw branch covered only the trailing
// hour, so every window whose start was not hour-aligned counted the whole
// leading hour — including spans BEFORE the window. The web app snaps a 12h
// range to a 5-minute grid, so the start was essentially never aligned: the DB
// nodes read high against the service edges drawn beside them, always, and
// nothing failed. The boundary now comes from `ch/queries/rollup-splice`; this
// is the test that says so in numbers rather than in SQL.
//
// The failure modes this is shaped to catch:
//
//   - The interior widening past the window at either end (the bug above).
//   - A boundary inequality inverting. Spans are seeded EXACTLY on
//     `firstFullHour` and on `endHourFloor`, and one second either side of each.
//     A tiling bug is invisible unless a row sits precisely on the seam.
//   - The raw edge and the rollup double-counting the same hour.
//   - Sample-weighted estimates diverging from the raw counts they are derived
//     from — the seed carries `SampleRate > 1` rows on both sides of a seam.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_service_map_parity_e2e")
const ORG_ID = "org_service_map_parity"

/**
 * The seed window is anchored to *now*, not a fixed calendar date: `traces`,
 * `service_map_spans` and `service_map_children` all enforce a TTL at insert
 * time, and a hardcoded date silently drops every row once it ages past the
 * horizon. Both sides of every comparison then go empty and the suite passes by
 * comparing nothing to nothing — which `seeds land in both tiers` prevents.
 */
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const SECOND_MS = 1000

const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)

/** Midnight, three days back — comfortably inside the TTL horizon on both ends. */
const BASE_MS = Math.floor((Date.now() - 3 * DAY_MS) / DAY_MS) * DAY_MS

// Deliberately unaligned at BOTH ends — :30:30 to :15:30 — so the leading
// partial hour, the interior and the trailing partial hour all hold real rows.
// An hour-aligned window collapses the raw edge to nothing and proves nothing.
const START_MS = BASE_MS + 10 * HOUR_MS + 30 * MINUTE_MS + 30 * SECOND_MS
const END_MS = BASE_MS + 14 * HOUR_MS + 15 * MINUTE_MS + 30 * SECOND_MS

const START_TIME = chDateTime(START_MS)
const END_TIME = chDateTime(END_MS)

// The two seams the hourly splice is built on.
const FIRST_FULL_HOUR_MS = BASE_MS + 11 * HOUR_MS
const END_HOUR_FLOOR_MS = BASE_MS + 14 * HOUR_MS

const window = { orgId: ORG_ID, startTime: START_TIME, endTime: END_TIME }

interface SeedSpan {
	readonly ms: number
	readonly service: string
	readonly kind: "Client" | "Server"
	readonly status: "Ok" | "Error"
	/** Nanoseconds — the column is UInt64 nanos. */
	readonly durationNs: number
	readonly sampleRate: number
	/** Set for DB-client spans; empty for the service↔service topology spans. */
	readonly dbSystem: string
	readonly dbNamespace: string
	/** Topology join key: a Server span names the Client span it descends from. */
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
}

let seq = 0
const dbSpan = (ms: number, overrides: Partial<SeedSpan> = {}): SeedSpan => {
	const id = seq++
	return {
		ms,
		service: "api",
		kind: "Client",
		status: "Ok",
		durationNs: 120_000_000,
		sampleRate: 1,
		dbSystem: "postgresql",
		dbNamespace: "orders",
		traceId: `trace-${id}`,
		spanId: `span-${id}`,
		parentSpanId: "",
		...overrides,
	}
}

/**
 * One service→service call as the two spans the topology join needs: a parent
 * Client span on `api` and its child Server span on `worker`. The edge is only
 * recoverable from the pair, which is why the map rolls it up rather than
 * reading a `peer.service` attribute that modern OTEL no longer emits.
 */
const callPair = (ms: number, overrides: Partial<SeedSpan> = {}): ReadonlyArray<SeedSpan> => {
	const id = seq++
	const traceId = `trace-call-${id}`
	const parentSpanId = `span-call-${id}`
	return [
		{
			ms,
			service: "api",
			kind: "Client",
			status: "Ok",
			durationNs: 90_000_000,
			sampleRate: 1,
			dbSystem: "",
			dbNamespace: "",
			traceId,
			spanId: parentSpanId,
			parentSpanId: "",
			...overrides,
		},
		{
			ms,
			service: "worker",
			kind: "Server",
			status: overrides.status ?? "Ok",
			durationNs: overrides.durationNs ?? 90_000_000,
			sampleRate: 1,
			dbSystem: "",
			dbNamespace: "",
			traceId,
			spanId: `${parentSpanId}-child`,
			parentSpanId,
		},
	]
}

const SEED_SPANS: ReadonlyArray<SeedSpan> = [
	// --- Boundary-exact DB rows. A tiling bug only shows up here. ---
	// Inside the leading partial hour — the raw edge must own these. Under the
	// old boundary the interior swallowed the whole hour and counted them twice.
	dbSpan(START_MS + SECOND_MS),
	dbSpan(FIRST_FULL_HOUR_MS - SECOND_MS, { status: "Error" }),
	// Exactly on the first whole hour — the rollup takes over here. If
	// `firstFullBucket` advanced unconditionally this row would be dropped.
	dbSpan(FIRST_FULL_HOUR_MS),
	// One second before the interior ends — last row the rollup owns.
	dbSpan(END_HOUR_FLOOR_MS - SECOND_MS, { durationNs: 900_000_000 }),
	// Exactly on the trailing hour floor — back to the raw edge.
	dbSpan(END_HOUR_FLOOR_MS, { status: "Error" }),
	dbSpan(END_HOUR_FLOOR_MS + 5 * MINUTE_MS),

	// --- Outside the window on both ends. Catches a bound that shifted. ---
	// The first is the row the old code counted: same leading hour, before the
	// window starts.
	dbSpan(START_MS - SECOND_MS, { dbNamespace: "before" }),
	dbSpan(BASE_MS + 10 * HOUR_MS + MINUTE_MS, { dbNamespace: "before" }),
	dbSpan(END_MS + SECOND_MS, { dbNamespace: "after" }),

	// --- Interior volume, so the rollup has real rows to aggregate. ---
	...Array.from({ length: 40 }, (_, i) =>
		dbSpan(FIRST_FULL_HOUR_MS + 20 * MINUTE_MS + i * MINUTE_MS, {
			durationNs: (50 + i * 10) * 1_000_000,
			status: i % 7 === 0 ? "Error" : "Ok",
		}),
	),
	// A second database identity, so the group-by has something to split.
	...Array.from({ length: 8 }, (_, i) =>
		dbSpan(FIRST_FULL_HOUR_MS + 90 * MINUTE_MS + i * MINUTE_MS, { dbNamespace: "billing" }),
	),
	// Head-sampled rows straddling a seam: SampleRate > 1 must widen the
	// estimate, not the raw count, on BOTH sides of the boundary.
	dbSpan(START_MS + 2 * MINUTE_MS, { sampleRate: 10 }),
	dbSpan(FIRST_FULL_HOUR_MS + 2 * MINUTE_MS, { sampleRate: 10, status: "Error" }),

	// --- Service↔service topology, on the same seams. ---
	...callPair(START_MS + 3 * SECOND_MS),
	...callPair(FIRST_FULL_HOUR_MS - SECOND_MS),
	...callPair(FIRST_FULL_HOUR_MS),
	...callPair(END_HOUR_FLOOR_MS - SECOND_MS, { status: "Error" }),
	...callPair(END_HOUR_FLOOR_MS),
	...callPair(START_MS - SECOND_MS),
	...callPair(END_MS + SECOND_MS),
	...Array.from({ length: 20 }, (_, i) =>
		callPair(FIRST_FULL_HOUR_MS + 30 * MINUTE_MS + i * MINUTE_MS, {
			status: i % 5 === 0 ? "Error" : "Ok",
		}),
	).flat(),
]

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

const seed = async (): Promise<void> => {
	const rows = SEED_SPANS.map((row) => {
		const spanAttributes =
			row.dbSystem === ""
				? "map('server.address', 'worker.internal')"
				: `map('db.system.name', ${quote(row.dbSystem)}, 'db.namespace', ${quote(row.dbNamespace)}, 'db.query.text', 'SELECT 1')`
		return `(${quote(ORG_ID)}, ${quote(chDateTime(row.ms))}, ${quote(row.traceId)}, ${quote(row.spanId)}, ${quote(row.parentSpanId)}, ${quote("op")}, ${quote(row.kind)}, ${quote(row.service)}, ${row.durationNs}, ${quote(row.status)}, ${row.sampleRate}, '', ${spanAttributes}, map('deployment.environment', 'production'))`
	}).join(",\n")

	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SampleRate, TraceState, SpanAttributes, ResourceAttributes)
		 VALUES\n${rows}`,
		database,
	)
}

/**
 * `service_map_edges_hourly` is filled by a SCHEDULED rollup, not a materialized
 * view — the edge needs a cross-span join an MV cannot express. Run that rollup
 * here for the hours the read path expects to be sealed, exactly as
 * `ServiceMapRollupService` does, so the interior tier under test is the real one.
 *
 * Only the WHOLE hours of the window are sealed. Sealing the partial ones would
 * hide the very bug this file exists to catch.
 */
const runEdgeRollup = async (): Promise<void> => {
	for (let hourMs = FIRST_FULL_HOUR_MS; hourMs < END_HOUR_FLOOR_MS; hourMs += HOUR_MS) {
		const { sql } = Effect.runSync(
			CH.serviceMapEdgesRollupSQL({
				orgId: ORG_ID,
				hourStart: chDateTime(hourMs),
				hourEnd: chDateTime(hourMs + HOUR_MS),
			}),
		)
		await clickhouseExec(
			`INSERT INTO service_map_edges_hourly_ingest ${normalizeSqlForClickHouseClient(sql)}`,
			database,
		)
	}
}

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	// `normalizeSqlForClickHouseClient` strips the trailing `FORMAT JSON` — the
	// official client sets the format itself — so ask for it as a setting instead
	// of leaving the server on its TabSeparated default.
	const body = await clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
	})
	const parsed = JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }
	return parsed.data ?? []
}

const num = (value: unknown): number => Number(value ?? 0)

/**
 * Ground truth for the DB edges: the same aggregation from a single flat scan of
 * raw `traces` over the window, with no splice at all. Raw `traces` is the right
 * baseline because it is the row set BOTH tiers derive from, so a disagreement
 * is a splice bug and never a difference in entry-point predicates.
 */
const DB_EDGE_TRUTH_SQL = `
	SELECT
		toString(ServiceName) AS sourceService,
		SpanAttributes['db.system.name'] AS dbSystem,
		SpanAttributes['db.namespace'] AS dbNamespace,
		count() AS callCount,
		countIf(StatusCode = 'Error') AS errorCount,
		sum(SampleRate) AS estimatedSpanCount
	FROM traces
	WHERE OrgId = ${quote(ORG_ID)}
		AND Timestamp >= ${quote(START_TIME)}
		AND Timestamp <= ${quote(END_TIME)}
		AND SpanKind IN ('Client', 'Producer')
		AND ServiceName != ''
		AND SpanAttributes['db.system.name'] != ''
	GROUP BY sourceService, dbSystem, dbNamespace
	ORDER BY sourceService ASC, dbSystem ASC, dbNamespace ASC
`

const SERVICE_EDGE_TRUTH_SQL = `
	SELECT
		toString(p.ServiceName) AS sourceService,
		toString(c.ServiceName) AS targetService,
		count() AS callCount,
		countIf(c.StatusCode = 'Error') AS errorCount
	FROM (
		SELECT TraceId, SpanId, ServiceName
		FROM traces
		WHERE OrgId = ${quote(ORG_ID)}
			AND SpanKind IN ('Client', 'Producer')
			AND Timestamp >= ${quote(START_TIME)} AND Timestamp <= ${quote(END_TIME)}
	) AS p
	INNER JOIN (
		SELECT TraceId, ParentSpanId, ServiceName, StatusCode
		FROM traces
		WHERE OrgId = ${quote(ORG_ID)}
			AND SpanKind IN ('Server', 'Consumer')
			AND Timestamp >= ${quote(START_TIME)} AND Timestamp <= ${quote(END_TIME)}
	) AS c ON p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId
	WHERE p.ServiceName != c.ServiceName
	GROUP BY sourceService, targetService
	ORDER BY sourceService ASC, targetService ASC
`

describe.skipIf(!clickhouseE2eEnabled)("service map raw-vs-rollup parity", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await seed()
		await runEdgeRollup()
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("seeds land in both tiers", async () => {
		// The guard against a vacuous suite. Every comparison below is an equality
		// between two result sets, and two empty sets satisfy all of them — which
		// is exactly what a TTL-expired seed produces, silently.
		const [traces, dbHourly, edgeHourly] = await Promise.all([
			runJson("SELECT count() AS n FROM traces"),
			runJson("SELECT sum(CallCount) AS n FROM service_map_db_edges_hourly"),
			runJson("SELECT sum(CallCount) AS n FROM service_map_edges_hourly"),
		])

		assert.strictEqual(
			num(traces[0]?.n),
			SEED_SPANS.length,
			"traces seed did not land — check the rows against the table's TTL",
		)
		assert.isAbove(num(dbHourly[0]?.n), 0, "service_map_db_edges_hourly is empty")
		assert.isAbove(num(edgeHourly[0]?.n), 0, "service_map_edges_hourly is empty — rollup did not run")
	})

	it("puts rows on every seam the splice depends on", async () => {
		// If these are ever zero the boundary cases above have stopped being
		// boundary cases, and the parity assertions weaken without failing.
		for (const seam of [FIRST_FULL_HOUR_MS, END_HOUR_FLOOR_MS]) {
			const rows = await runJson(
				`SELECT count() AS n FROM traces WHERE Timestamp = ${quote(chDateTime(seam))}`,
			)
			assert.isAbove(num(rows[0]?.n), 0, `no span sits exactly on seam ${chDateTime(seam)}`)
		}
	})

	it("seals only the whole hours, so the raw edge is load-bearing", async () => {
		// If the rollup covered the partial hours too, the interior could widen
		// past the window and every assertion below would still pass.
		const rows = await runJson(`SELECT min(Hour) AS lo, max(Hour) AS hi FROM service_map_edges_hourly`)
		assert.strictEqual(String(rows[0]?.lo), chDateTime(FIRST_FULL_HOUR_MS))
		assert.strictEqual(String(rows[0]?.hi), chDateTime(END_HOUR_FLOOR_MS - HOUR_MS))
	})

	it("matches a flat scan — database edges", async () => {
		const [spliced, truth] = await Promise.all([
			runJson(Effect.runSync(CH.serviceDbEdgesSQL({}, window)).sql),
			runJson(DB_EDGE_TRUTH_SQL),
		])

		assert.isAbove(truth.length, 1, "ground truth collapsed to a single group — seed is too thin")
		const key = (row: Record<string, unknown>) =>
			`${String(row.sourceService)}::${String(row.dbSystem)}::${String(row.dbNamespace)}`
		const bySplice = new Map(spliced.map((row) => [key(row), row]))

		assert.deepStrictEqual(
			[...bySplice.keys()].sort(),
			truth.map(key).sort(),
			"spliced query and flat scan disagree on which database edges exist",
		)
		for (const expected of truth) {
			const actual = bySplice.get(key(expected))
			assert.isDefined(actual, `missing edge ${key(expected)}`)
			assert.strictEqual(num(actual?.callCount), num(expected.callCount), `callCount ${key(expected)}`)
			assert.strictEqual(
				num(actual?.errorCount),
				num(expected.errorCount),
				`errorCount ${key(expected)}`,
			)
			assert.closeTo(
				num(actual?.estimatedSpanCount),
				num(expected.estimatedSpanCount),
				0.001,
				`estimatedSpanCount ${key(expected)}`,
			)
		}
	})

	// Migration 0022 gave the edge rollups a t-digest so a database node can show a
	// real p95 instead of the max it showed for months. The digest is merged from
	// the sealed hourly buckets and computed live over the partial boundary hours,
	// so this asserts the SPLICED merge lands on the same value as one quantile
	// taken over the whole window in a single pass — the boundary and the digest
	// have to be right together for that to hold.
	it("merges a p95 equal to a single-pass quantile over the same window", async () => {
		const [spliced, truth] = await Promise.all([
			runJson(Effect.runSync(CH.serviceDbEdgesSQL({}, window)).sql),
			runJson(`
				SELECT
					toString(ServiceName) AS sourceService,
					SpanAttributes['db.system.name'] AS dbSystem,
					SpanAttributes['db.namespace'] AS dbNamespace,
					arrayElement(
						quantilesTDigestWeighted(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))),
						2
					) / 1000000 AS p95DurationMs
				FROM traces
				WHERE OrgId = ${quote(ORG_ID)}
					AND Timestamp >= ${quote(START_TIME)}
					AND Timestamp <= ${quote(END_TIME)}
					AND SpanKind IN ('Client', 'Producer')
					AND ServiceName != ''
					AND SpanAttributes['db.system.name'] != ''
				GROUP BY sourceService, dbSystem, dbNamespace
			`),
		])

		const key = (row: Record<string, unknown>) =>
			`${String(row.sourceService)}::${String(row.dbSystem)}::${String(row.dbNamespace)}`
		const bySplice = new Map(spliced.map((row) => [key(row), row]))

		let compared = 0
		for (const expected of truth) {
			const actual = bySplice.get(key(expected))
			assert.isDefined(actual, `missing edge ${key(expected)}`)
			// A t-digest is approximate by construction, and the spliced value merges
			// several partial digests where the baseline builds one. The tolerance is
			// on the ORDER of the value, not a fixed epsilon, so it stays meaningful
			// across the fixture's 120ms and 900ms groups — and it is nowhere near
			// wide enough to let a max (3s against a 7ms p95) pass as a p95.
			assert.closeTo(
				num(actual?.p95DurationMs),
				num(expected.p95DurationMs),
				Math.max(num(expected.p95DurationMs) * 0.1, 1),
				`p95 ${key(expected)}`,
			)
			compared += 1
		}
		assert.isAbove(compared, 1, "p95 comparison covered fewer than two edges")
	})

	it("reports a p95 well below the max when the tail is long", async () => {
		// The guard against the comparison above passing vacuously on a fixture
		// whose durations are all identical: if p95 and max coincide, a regression
		// back to `max(MaxDurationMs)` would satisfy every assertion here.
		const rows = await runJson(Effect.runSync(CH.serviceDbEdgesSQL({}, window)).sql)
		const orders = rows.find((row) => String(row.dbNamespace) === "orders")
		assert.isDefined(orders, "the `orders` edge is missing from the fixture")
		assert.isAbove(num(orders?.maxDurationMs), num(orders?.p95DurationMs) * 2)
	})

	it("matches a flat scan — service edges", async () => {
		const [spliced, truth] = await Promise.all([
			runJson(Effect.runSync(CH.serviceDependenciesSQL({}, window)).sql),
			runJson(SERVICE_EDGE_TRUTH_SQL),
		])

		assert.isAbove(truth.length, 0, "ground truth found no service edges — seed is too thin")
		const key = (row: Record<string, unknown>) =>
			`${String(row.sourceService)}::${String(row.targetService)}`
		const bySplice = new Map(spliced.map((row) => [key(row), row]))

		assert.deepStrictEqual([...bySplice.keys()].sort(), truth.map(key).sort())
		for (const expected of truth) {
			const actual = bySplice.get(key(expected))
			assert.strictEqual(num(actual?.callCount), num(expected.callCount), `callCount ${key(expected)}`)
			assert.strictEqual(
				num(actual?.errorCount),
				num(expected.errorCount),
				`errorCount ${key(expected)}`,
			)
		}
	})

	it("matches a flat scan — database query summary", async () => {
		// The panel the user reads when they click a database node. It splices the
		// same way, off a different rollup (`service_map_db_query_shapes_hourly`).
		const [spliced, truth] = await Promise.all([
			runJson(Effect.runSync(CH.serviceDbQuerySummarySQL({ ...window, dbSystem: "postgresql" })).sql),
			runJson(DB_EDGE_TRUTH_SQL),
		])

		const expectedCalls = truth.reduce((sum, row) => sum + num(row.callCount), 0)
		const expectedErrors = truth.reduce((sum, row) => sum + num(row.errorCount), 0)
		assert.strictEqual(num(spliced[0]?.queryCount), expectedCalls, "summary queryCount")
		assert.strictEqual(num(spliced[0]?.errorCount), expectedErrors, "summary errorCount")
	})
})
