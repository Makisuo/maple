// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// Raw-vs-rollup parity for the service-overview tiers.
//
// The services list reconstructs its window from up to three sources at once:
// exact raw rows for the two partial boundary buckets, `service_overview_minutely`
// for the sub-hour remainder, and `service_overview_hourly` for the whole-hour
// interior. Correctness rests entirely on those tiers TILING the window — covering
// it exactly once, with no gap and no overlap.
//
// That property cannot be checked by reading the SQL. A `<=` where a `<` belongs
// double-counts a bucket; a `<` where a `<=` belongs drops one. Both produce a
// perfectly plausible chart. The only proof is running the spliced query and a
// ground-truth scan of the same rows and comparing the numbers.
//
// The failure modes this is shaped to catch:
//
//   - A boundary inequality inverting. Spans are seeded EXACTLY on
//     `firstFullMinute`, one second before it, on `endMinuteFloor`, on
//     `firstFullHour`, and one second before `endHourFloor`. A tiling bug is
//     invisible unless a row sits precisely on the seam.
//   - The hourly tier answering a sub-hour bucket. An hour-floored row carries no
//     position inside the hour, so it would pile a whole hour of traffic onto the
//     bucket containing `:00`. The 300s cases below would show one spike per hour.
//   - `serviceOverviewQuery` averaging quantiles instead of merging tDigest
//     states. The skewed-namespace seed exists so a weighted mean and a real p95
//     cannot coincide.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_service_overview_parity_e2e")
const ORG_ID = "org_service_overview_parity"

/**
 * The seed window is anchored to *now*, not to a fixed calendar date.
 *
 * `traces` and `service_overview_spans` both carry a 30-day TTL, enforced at
 * insert time. A hardcoded date silently drops every seeded row once it ages past
 * the horizon; both sides of every comparison below go empty and the whole suite
 * passes by comparing nothing to nothing. `seeds land in all three tiers` is the
 * assertion that makes that impossible.
 */
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const SECOND_MS = 1000

const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)

/** Midnight, three days back — comfortably inside the TTL horizon on both ends. */
const BASE_MS = Math.floor((Date.now() - 3 * DAY_MS) / DAY_MS) * DAY_MS

// The window deliberately straddles BOTH seams at once: it starts at :30:30 and
// ends at :15:30 several hours later, so the raw edge, the minute tier and the
// hour tier all contribute a non-empty slice. A window aligned to either boundary
// would collapse a tier to zero rows and prove nothing about it.
const START_MS = BASE_MS + 10 * HOUR_MS + 30 * MINUTE_MS + 30 * SECOND_MS
const END_MS = BASE_MS + 14 * HOUR_MS + 15 * MINUTE_MS + 30 * SECOND_MS

const START_TIME = chDateTime(START_MS)
const END_TIME = chDateTime(END_MS)

// The four seams the splice is built on.
const FIRST_FULL_MINUTE_MS = BASE_MS + 10 * HOUR_MS + 31 * MINUTE_MS
const FIRST_FULL_HOUR_MS = BASE_MS + 11 * HOUR_MS
const END_HOUR_FLOOR_MS = BASE_MS + 14 * HOUR_MS
const END_MINUTE_FLOOR_MS = BASE_MS + 14 * HOUR_MS + 15 * MINUTE_MS

const window = { orgId: ORG_ID, startTime: START_TIME, endTime: END_TIME }

interface SeedSpan {
	readonly ms: number
	readonly service: string
	readonly namespace: string
	readonly environment: string
	readonly commitSha: string
	/** Nanoseconds — the column is UInt64 nanos, and Apdex thresholds are 500ms/2s. */
	readonly durationNs: number
	readonly status: "Ok" | "Error"
	readonly sampleRate: number
}

const span = (ms: number, overrides: Partial<Omit<SeedSpan, "ms">> = {}): SeedSpan => ({
	ms,
	service: "api",
	namespace: "checkout",
	environment: "production",
	commitSha: "abc123",
	durationNs: 120_000_000,
	status: "Ok",
	sampleRate: 1,
	...overrides,
})

const SEED_SPANS: ReadonlyArray<SeedSpan> = [
	// --- Boundary-exact rows. A tiling bug only shows up here. ---
	// Inside the leading partial minute, so the raw edge must own it.
	span(START_MS + 1),
	// One second before the first whole minute — still the raw edge.
	span(FIRST_FULL_MINUTE_MS - SECOND_MS),
	// Exactly on the first whole minute — the minute tier's first row. If
	// `firstFullBucket` advanced unconditionally this would be counted twice.
	span(FIRST_FULL_MINUTE_MS, { status: "Error" }),
	// Exactly on the first whole hour — the hour tier takes over here.
	span(FIRST_FULL_HOUR_MS),
	// One second before the hour interior ends — last row the hour tier owns.
	span(END_HOUR_FLOOR_MS - SECOND_MS, { durationNs: 900_000_000 }),
	// Exactly on the hour floor — back to the minute tier.
	span(END_HOUR_FLOOR_MS),
	// Exactly on the trailing minute floor — back to the raw edge.
	span(END_MINUTE_FLOOR_MS, { status: "Error" }),
	// Inside the trailing partial minute.
	span(END_MINUTE_FLOOR_MS + 15 * SECOND_MS),

	// --- Outside the window on both ends. Catches a bound that shifted. ---
	span(START_MS - SECOND_MS, { commitSha: "before" }),
	span(END_MS + SECOND_MS, { commitSha: "after" }),

	// --- Interior volume, spread so every tier has real rows to aggregate. ---
	...Array.from({ length: 40 }, (_, i) =>
		span(FIRST_FULL_HOUR_MS + 20 * MINUTE_MS + i * MINUTE_MS, {
			durationNs: (50 + i * 10) * 1_000_000,
			status: i % 7 === 0 ? "Error" : "Ok",
		}),
	),
	// Apdex band coverage: satisfied (<500ms), tolerating (500ms–2s), frustrated.
	span(FIRST_FULL_HOUR_MS + MINUTE_MS, { durationNs: 300_000_000 }),
	span(FIRST_FULL_HOUR_MS + 2 * MINUTE_MS, { durationNs: 1_500_000_000 }),
	span(FIRST_FULL_HOUR_MS + 3 * MINUTE_MS, { durationNs: 5_000_000_000 }),
	// Head-sampled rows: SampleRate > 1 must widen the estimate, not the raw count.
	span(FIRST_FULL_HOUR_MS + 4 * MINUTE_MS, { sampleRate: 10 }),
	span(FIRST_FULL_HOUR_MS + 5 * MINUTE_MS, { sampleRate: 10, status: "Error" }),

	// --- A second service and a second commit, so groupBy has something to split. ---
	...Array.from({ length: 12 }, (_, i) =>
		span(FIRST_FULL_HOUR_MS + 30 * MINUTE_MS + i * MINUTE_MS, {
			service: "worker",
			namespace: "jobs",
			commitSha: i < 6 ? "abc123" : "def456",
			durationNs: (200 + i * 25) * 1_000_000,
			status: i % 4 === 0 ? "Error" : "Ok",
		}),
	),

	// --- The skewed-namespace pair for the quantile-merge assertion. ---
	// `slow` carries 10x the spans at 10x the latency of `fast`. A span-weighted
	// MEAN of the two namespaces' p95s lands nowhere near the merged p95, which is
	// what makes the assertion below able to fail.
	...Array.from({ length: 200 }, (_, i) =>
		span(FIRST_FULL_HOUR_MS + 40 * MINUTE_MS + (i % 30) * MINUTE_MS, {
			service: "skewed",
			namespace: "slow",
			durationNs: (2000 + i) * 1_000_000,
		}),
	),
	...Array.from({ length: 20 }, (_, i) =>
		span(FIRST_FULL_HOUR_MS + 40 * MINUTE_MS + (i % 15) * MINUTE_MS, {
			service: "skewed",
			namespace: "fast",
			durationNs: (20 + i) * 1_000_000,
		}),
	),
]

/** Rows the query window actually covers — the denominator for the tripwire. */
const IN_WINDOW_SPANS = SEED_SPANS.filter((row) => row.ms >= START_MS && row.ms <= END_MS)

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

const seed = async (): Promise<void> => {
	const rows = SEED_SPANS.map((row, index) => {
		const resourceAttributes = `map('deployment.environment', ${quote(row.environment)}, 'service.namespace', ${quote(row.namespace)}, 'vcs.ref.head.revision', ${quote(row.commitSha)})`
		return `(${quote(ORG_ID)}, ${quote(chDateTime(row.ms))}, ${quote(`trace-${index}`)}, ${quote(`span-${index}`)}, '', ${quote("GET /x")}, 'Server', ${quote(row.service)}, ${row.durationNs}, ${quote(row.status)}, ${row.sampleRate}, ${resourceAttributes})`
	}).join(",\n")

	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SampleRate, ResourceAttributes)
		 VALUES\n${rows}`,
		database,
	)
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

/**
 * Ground truth: the same aggregation computed by a single flat scan of the
 * per-span projection, with no splice at all.
 *
 * `service_overview_spans` is the right baseline rather than raw `traces`: it is
 * exactly the row set the rollups are derived from, so a disagreement here is a
 * splice bug and never an entry-point-predicate difference.
 */
const groundTruthSql = (bucketSeconds: number, groupByService: boolean): string => `
	SELECT
		toStartOfInterval(Timestamp, INTERVAL ${bucketSeconds} SECOND) AS bucket,
		${groupByService ? "toString(ServiceName)" : "'all'"} AS groupName,
		count() AS spanCount,
		sum(SampleRate) AS estimatedSpanCount,
		if(count() > 0, countIf(StatusCode = 'Error') / count(), 0) AS errorRate,
		countIf(StatusCode != 'Error' AND Duration < 500000000) AS satisfiedCount,
		countIf(StatusCode != 'Error' AND Duration >= 500000000 AND Duration < 2000000000) AS toleratingCount,
		arrayElement(quantilesTDigest(0.5, 0.95, 0.99)(Duration), 2) / 1000000 AS p95Duration
	FROM service_overview_spans
	WHERE OrgId = ${quote(ORG_ID)}
		AND Timestamp >= ${quote(START_TIME)}
		AND Timestamp <= ${quote(END_TIME)}
	GROUP BY bucket, groupName
	ORDER BY bucket ASC, groupName ASC
`

const splicedSql = (bucketSeconds: number, groupByService: boolean): string =>
	CH.compileUnsafe(
		CH.tracesTimeseriesQuery({
			metric: "count",
			allMetrics: true,
			needsSampling: true,
			rootOnly: true,
			bucketSeconds,
			groupBy: groupByService ? ["service"] : undefined,
		}),
		{ ...window, bucketSeconds },
	).sql

const key = (row: Record<string, unknown>): string => `${String(row.bucket)}::${String(row.groupName)}`

const num = (value: unknown): number => Number(value ?? 0)

/** The cases the services list and its detail charts actually produce. */
const BUCKET_CASES = [300, 900, 3600, 7200] as const

describe.skipIf(!clickhouseE2eEnabled)("service overview raw-vs-rollup parity", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await seed()
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("seeds land in all three tiers", async () => {
		// The guard against a vacuous suite. Every comparison below is an equality
		// between two result sets, and two empty result sets satisfy all of them —
		// which is exactly what a TTL-expired seed produces, silently.
		const [spans, minutely, hourly] = await Promise.all([
			runJson("SELECT count() AS n FROM service_overview_spans"),
			runJson("SELECT sum(SpanCount) AS n FROM service_overview_minutely"),
			runJson("SELECT sum(SpanCount) AS n FROM service_overview_hourly"),
		])

		assert.strictEqual(
			num(spans[0]?.n),
			SEED_SPANS.length,
			"service_overview_spans seed did not land — check the rows against the table's 30-day TTL",
		)
		// Both rollups are fed from the same insert, so they see every seeded span,
		// including the two outside the query window.
		assert.strictEqual(num(minutely[0]?.n), SEED_SPANS.length, "service_overview_minutely is empty")
		assert.strictEqual(num(hourly[0]?.n), SEED_SPANS.length, "service_overview_hourly is empty")
	})

	it("puts rows on every seam the splice depends on", async () => {
		// If these are ever zero the boundary cases above have stopped being
		// boundary cases and the parity assertions get much weaker without failing.
		const seams = [FIRST_FULL_MINUTE_MS, FIRST_FULL_HOUR_MS, END_HOUR_FLOOR_MS, END_MINUTE_FLOOR_MS]
		for (const seam of seams) {
			const rows = await runJson(
				`SELECT count() AS n FROM service_overview_spans WHERE Timestamp = ${quote(chDateTime(seam))}`,
			)
			assert.isAbove(num(rows[0]?.n), 0, `no span sits exactly on seam ${chDateTime(seam)}`)
		}
	})

	// A `for` loop, not `describe.each`: the latter OOMs tsc in this repo.
	for (const bucketSeconds of BUCKET_CASES) {
		for (const groupByService of [false, true]) {
			const label = `${bucketSeconds}s buckets${groupByService ? " grouped by service" : ""}`

			it(`matches a flat scan — ${label}`, async () => {
				const [spliced, truth] = await Promise.all([
					runJson(splicedSql(bucketSeconds, groupByService)),
					runJson(groundTruthSql(bucketSeconds, groupByService)),
				])

				assert.isAbove(truth.length, 0, "ground truth returned no rows — the seed missed the window")
				assert.strictEqual(
					spliced.length,
					truth.length,
					`bucket/group count differs — the tiers do not tile the window (${label})`,
				)

				const truthByKey = new Map(truth.map((row) => [key(row), row]))
				for (const row of spliced) {
					const expected = truthByKey.get(key(row))
					assert.isDefined(expected, `spliced produced a bucket the flat scan did not: ${key(row)}`)
					if (!expected) continue

					// Counts must be EXACT. These are the ones a boundary inequality
					// corrupts, and they corrupt by a whole bucket, not by rounding.
					assert.strictEqual(num(row.spanCount), num(expected.spanCount), `spanCount @ ${key(row)}`)
					assert.strictEqual(
						num(row.estimatedSpanCount),
						num(expected.estimatedSpanCount),
						`estimatedSpanCount @ ${key(row)}`,
					)
					assert.strictEqual(
						num(row.satisfiedCount),
						num(expected.satisfiedCount),
						`satisfiedCount @ ${key(row)}`,
					)
					assert.strictEqual(
						num(row.toleratingCount),
						num(expected.toleratingCount),
						`toleratingCount @ ${key(row)}`,
					)
					assert.closeTo(
						num(row.errorRate),
						num(expected.errorRate),
						1e-12,
						`errorRate @ ${key(row)}`,
					)

					// Quantiles are NOT bit-identical and are not supposed to be: the flat
					// scan builds one tDigest over every span, while the spliced query
					// merges per-minute and per-hour digests. Merging is lossy at the
					// margins. Do not "fix" this to a strict equality — it will flake.
					const expectedP95 = num(expected.p95Duration)
					const tolerance = Math.max(expectedP95 * 0.01, 1e-6)
					assert.closeTo(
						num(row.p95Duration),
						expectedP95,
						tolerance,
						`p95Duration @ ${key(row)} (merged tDigest, ~1% tolerance)`,
					)
				}
			})
		}
	}

	it("totals identically whether or not the hourly tier participates", async () => {
		// One scalar per side, so this catches a tiling gap regardless of how the
		// buckets happen to line up. `overviewTiers: "hour"` is the retry path taken
		// on a cluster missing migration 0015 — it must not change the answer.
		const sumOf = async (sql: string): Promise<number> => {
			const rows = await runJson(sql)
			return rows.reduce((total, row) => total + num(row.spanCount), 0)
		}

		const threeTier = await sumOf(splicedSql(3600, false))
		const twoTier = await sumOf(
			CH.compileUnsafe(
				CH.tracesTimeseriesQuery({
					metric: "count",
					allMetrics: true,
					needsSampling: true,
					rootOnly: true,
					bucketSeconds: 3600,
					overviewTiers: "hour",
				}),
				{ ...window, bucketSeconds: 3600 },
			).sql,
		)

		assert.strictEqual(threeTier, IN_WINDOW_SPANS.length, "three-tier splice lost or duplicated rows")
		assert.strictEqual(twoTier, IN_WINDOW_SPANS.length, "two-tier splice lost or duplicated rows")
	})

	it("keeps the hourly tier out of sub-hour buckets", async () => {
		// The SQL-level guarantee behind the 300s parity case above. Asserted on the
		// compiled text because the numeric symptom — one spike per hour with zeros
		// between — is only visible with a seed shaped to expose it.
		assert.include(splicedSql(300, true), "service_overview_minutely")
		assert.notInclude(splicedSql(300, true), "service_overview_hourly")
		assert.include(splicedSql(3600, true), "service_overview_hourly")
	})

	it("merges tDigest states rather than averaging namespace quantiles", async () => {
		const rows = await runJson(CH.compileUnsafe(CH.serviceOverviewQuery({}), window).sql)
		const skewed = rows.find((row) => String(row.serviceName) === "skewed")
		assert.isDefined(skewed, "the skewed-namespace seed did not reach serviceOverviewQuery")
		if (!skewed) return

		// What the client used to compute: a span-count-weighted mean of each
		// namespace's own p95.
		const perNamespace = await runJson(`
			SELECT
				ServiceNamespace AS ns,
				count() AS spanCount,
				arrayElement(quantilesTDigest(0.5, 0.95, 0.99)(Duration), 2) / 1000000 AS p95
			FROM service_overview_spans
			WHERE OrgId = ${quote(ORG_ID)}
				AND ServiceName = 'skewed'
				AND Timestamp >= ${quote(START_TIME)}
				AND Timestamp <= ${quote(END_TIME)}
			GROUP BY ns
		`)
		assert.lengthOf(perNamespace, 2, "the skew seed must produce two namespaces")

		const totalSpans = perNamespace.reduce((total, row) => total + num(row.spanCount), 0)
		const weightedMeanP95 = perNamespace.reduce(
			(total, row) => total + num(row.p95) * (num(row.spanCount) / totalSpans),
			0,
		)
		const mergedP95 = num(skewed.p95LatencyMs)

		// Both numbers are real; only one is a p95. If these ever agree the seed has
		// stopped being skewed and this test has stopped testing anything.
		assert.isAbove(
			Math.abs(mergedP95 - weightedMeanP95),
			1,
			`merged p95 (${mergedP95}) and weighted mean (${weightedMeanP95}) agree — the seed is no longer skewed`,
		)

		// And the merged value is the one that matches a single digest over all spans.
		const truth = await runJson(`
			SELECT arrayElement(quantilesTDigest(0.5, 0.95, 0.99)(Duration), 2) / 1000000 AS p95
			FROM service_overview_spans
			WHERE OrgId = ${quote(ORG_ID)}
				AND ServiceName = 'skewed'
				AND Timestamp >= ${quote(START_TIME)}
				AND Timestamp <= ${quote(END_TIME)}
		`)
		assert.closeTo(mergedP95, num(truth[0]?.p95), Math.max(num(truth[0]?.p95) * 0.01, 1e-6))
	})

	it("collapses namespace variants into one row per service and environment", async () => {
		const rows = await runJson(CH.compileUnsafe(CH.serviceOverviewQuery({}), window).sql)
		const skewed = rows.filter((row) => String(row.serviceName) === "skewed")
		assert.lengthOf(skewed, 1, "namespace variants must not surface as separate rows")
		// argMax on estimated span count — `slow` carries 200 spans to `fast`'s 20.
		assert.strictEqual(String(skewed[0]?.serviceNamespace), "slow")

		// Commits ride along as a capped, count-descending tuple array.
		const worker = rows.find((row) => String(row.serviceName) === "worker")
		assert.isDefined(worker, "the worker seed did not reach serviceOverviewQuery")
		const commits = (worker?.commits ?? []) as ReadonlyArray<ReadonlyArray<unknown>>
		assert.lengthOf(commits, 2, "worker was seeded with exactly two commits")
		assert.isAtLeast(
			num(commits[0]?.[1]),
			num(commits[1]?.[1]),
			"commits must arrive sorted by span count descending",
		)
	})
})
