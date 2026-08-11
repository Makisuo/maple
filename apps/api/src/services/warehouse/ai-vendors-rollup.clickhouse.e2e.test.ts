// Reader contract and raw-vs-rollup parity for `service_ai_vendors_hourly`.
//
// The rollup's whole value is a coverage ratio a customer is shown, and every
// way it can be wrong is silent: an HLL state that merges across the wrong
// grouping still returns a plausible percentage, a counter identity that stops
// holding still renders, and a reader that assumes one row per key returns the
// last-inserted part's numbers instead of the total. None of that is visible in
// SQL-text tests, so this suite runs the real migrations against a real server,
// seeds spans whose correct answers are known by construction, and checks the
// answers rather than the syntax.
//
// The failure modes it is shaped to catch:
//
//   - The plan's CI identity breaking:
//     `EligibleSpanCount = KeyAbsent + KeyInvalid + KeySubSession + KeySession`.
//     A state enum that grows a value, or a `countIf` predicate that drifts,
//     shows up here and nowhere else.
//   - A reader assuming merged parts. The seed deliberately writes each key
//     across several INSERTs so every key has multiple unmerged rows; a query
//     without `GROUP BY` reads low, and `FINAL` is not an escape hatch.
//   - Per-vendor coverage being mistaken for the headline. The two-vendor trace
//     (litellm + langchain, key on langchain only) is the plan's worked example:
//     merging TracesWithKey/TracesTotal across vendor rows gives 100%, while
//     litellm's own row reads 0% on a fully resolvable trace.
//   - `WeightedSpanCount` losing its floor. A span with SampleRate 0 must
//     contribute 1.0, not 0 and not an infinity.
//   - The MV grouping on something other than the stored `AiRollupHour` — a
//     `toStartOfHour(Timestamp)` regression is invisible until a clock-skewed
//     client opens a partition in 2038.
//   - Non-AI traffic leaking into the rollup, which is both a cost regression
//     and a semantics one: post-enablement, "no rows" must mean "no AI spans".

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_ai_vendors_rollup_e2e")

const ORG_A = "org_ai_rollup_a"
const ORG_B = "org_ai_rollup_b"

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * Anchored to *now*, not a fixed date. `traces` carries a 30-day TTL enforced at
 * insert time, so a hardcoded calendar date silently drops every seeded row once
 * it ages past the horizon — both sides of every comparison below go empty and
 * the suite passes by comparing nothing to nothing. `the seed lands` exists to
 * make that impossible.
 */
const BASE_MS = Math.floor((Date.now() - 3 * DAY_MS) / HOUR_MS) * HOUR_MS

const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)

/** Hour `n` of the fixture, as the value ingest would have written to AiRollupHour. */
const hour = (n: number): string => chDateTime(BASE_MS + n * HOUR_MS)

/**
 * A seeded span. `sampleRate === undefined` means the column is left out of the
 * INSERT entirely, so the table's DEFAULT expression computes it — the shape a
 * writer that predates sample-awareness produces.
 */
interface SeedSpan {
	readonly orgId: string
	readonly service: string
	readonly vendor: string
	readonly traceId: string
	readonly hourIndex: number
	readonly state: number
	readonly keyHash: string
	readonly rulesVersion: number
	readonly sampleRate?: number
}

const span = (
	orgId: string,
	service: string,
	vendor: string,
	traceId: string,
	hourIndex: number,
	state: number,
	overrides: Partial<SeedSpan> = {},
): SeedSpan => ({
	orgId,
	service,
	vendor,
	traceId,
	hourIndex,
	state,
	keyHash: state >= 5 ? "11" : "0",
	rulesVersion: 7,
	sampleRate: 1,
	...overrides,
})

/**
 * A session-key hash above 2^53. UInt64 identity values corrupt as JS numbers,
 * which is why the schema notes require `toString()` in the SELECT — this row
 * makes a regression there a failing assertion rather than a rounding artifact
 * nobody notices.
 */
const BIG_HASH = "9007199254740993"

const SEED_SPANS: ReadonlyArray<SeedSpan> = [
	// ── The plan's worked case: one trace, two vendors, key on one of them.
	// Merged across vendor rows the trace is covered; litellm's own row reads 0%.
	span(ORG_A, "checkout", "langchain", "trace-mix", 0, 6, { keyHash: "101" }),
	span(ORG_A, "checkout", "litellm", "trace-mix", 0, 3),

	// ── One trace spanning two hours: each hour counts it once, and merging the
	// two hours must still yield one trace, not two.
	span(ORG_A, "checkout", "openai", "trace-dup", 0, 6, { keyHash: "202" }),
	span(ORG_A, "checkout", "openai", "trace-dup", 1, 6, { keyHash: "202" }),

	// ── Every state, so the eligibility identity is exercised rather than
	// asserted over an all-state-6 population. 0/1/2 are AI spans that were never
	// session-key eligible: they count in SpanCount but not EligibleSpanCount.
	span(ORG_A, "checkout", "openai", "trace-s0", 0, 0),
	span(ORG_A, "checkout", "openai", "trace-s1", 0, 1),
	span(ORG_A, "checkout", "openai", "trace-s2", 0, 2),
	span(ORG_A, "checkout", "openai", "trace-s3", 0, 3),
	span(ORG_A, "checkout", "openai", "trace-s4", 0, 4),
	span(ORG_A, "checkout", "openai", "trace-s5", 0, 5, { keyHash: "303" }),
	span(ORG_A, "checkout", "openai", "trace-s6", 0, 6, { keyHash: BIG_HASH }),

	// ── SampleRate variants. 0 must floor to 1.0; the undefined one leaves the
	// column out of the INSERT so the table's DEFAULT runs.
	span(ORG_A, "worker", "openai", "trace-sr4", 0, 6, { sampleRate: 4, keyHash: "404" }),
	span(ORG_A, "worker", "openai", "trace-sr0", 0, 6, { sampleRate: 0, keyHash: "505" }),
	span(ORG_A, "worker", "openai", "trace-srd", 0, 3, { sampleRate: undefined }),

	// ── A second org and a second hour, so nothing can pass by accident on a
	// single-group fixture and OrgId scoping is actually under test.
	span(ORG_B, "checkout", "langchain", "trace-b1", 1, 6, { keyHash: "606", rulesVersion: 8 }),
	span(ORG_B, "checkout", "langchain", "trace-b2", 1, 4, { rulesVersion: 9 }),
	span(ORG_B, "worker", "litellm", "trace-b3", 2, 5, { keyHash: "707", rulesVersion: 8 }),
]

/**
 * Non-AI spans in the same orgs, services and hours. Post-enablement the rollup
 * having no row for a service-hour must mean "genuinely no AI spans", so these
 * must contribute nothing at all — not a zero row.
 */
const SEED_NON_AI: ReadonlyArray<SeedSpan> = [
	span(ORG_A, "checkout", "", "trace-plain-1", 0, 0),
	span(ORG_A, "checkout", "", "trace-plain-2", 0, 0),
	span(ORG_A, "worker", "", "trace-plain-3", 1, 0),
	span(ORG_B, "checkout", "", "trace-plain-4", 1, 0),
	// A non-AI span carrying a session-key state is the awkward one: if the MV
	// ever filtered on state instead of vendor, this row would appear.
	span(ORG_A, "checkout", "", "trace-plain-5", 0, 6, { keyHash: "808" }),
]

/**
 * Three INSERT batches over overlapping keys. Each lands its own part, so every
 * rollup key ends up with several unmerged rows — which is what makes the
 * "aggregate, never assume one row per key" assertions non-vacuous. The overlap
 * also means duplicated *spans*: counters see them twice (correctly — they are
 * distinct SpanIds only in name, and at-least-once counters are the documented
 * behaviour of every Maple rollup), while `uniq` states do not.
 */
const AI_BATCHES: ReadonlyArray<ReadonlyArray<SeedSpan>> = [
	SEED_SPANS.slice(0, 8),
	SEED_SPANS.slice(8),
	SEED_SPANS.slice(0, 4),
]

const AI_SPANS_INSERTED = AI_BATCHES.reduce((total, batch) => total + batch.length, 0)

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

const insertBatch = async (rows: ReadonlyArray<SeedSpan>): Promise<void> => {
	// Two column lists, because a row that wants the SampleRate DEFAULT must omit
	// the column rather than pass a value.
	const withRate = rows.filter((row) => row.sampleRate !== undefined)
	const withoutRate = rows.filter((row) => row.sampleRate === undefined)

	const common = (row: SeedSpan): string =>
		`${quote(row.orgId)}, ${quote(chDateTime(BASE_MS + row.hourIndex * HOUR_MS + 60_000))}, ${quote(row.traceId)}, ${quote(`span-${row.traceId}-${row.vendor}-${row.hourIndex}`)}, 'op', 'Client', ${quote(row.service)}, 1000, 'Ok', ${quote(row.vendor)}, ${row.state}, ${row.keyHash}, ${row.rulesVersion}, ${quote(hour(row.hourIndex))}`

	if (withRate.length > 0) {
		await clickhouseExec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, AiVendor, AiSessionKeyState, AiSessionKeyHash, AiRulesVersion, AiRollupHour, SampleRate) VALUES\n${withRate
				.map((row) => `(${common(row)}, ${row.sampleRate})`)
				.join(",\n")}`,
			database,
		)
	}
	if (withoutRate.length > 0) {
		await clickhouseExec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, AiVendor, AiSessionKeyState, AiSessionKeyHash, AiRulesVersion, AiRollupHour) VALUES\n${withoutRate
				.map((row) => `(${common(row)})`)
				.join(",\n")}`,
			database,
		)
	}
}

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(sql, database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
	})
	const parsed = JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }
	return parsed.data ?? []
}

const num = (value: unknown): number => Number(value)

/** Stable, order-insensitive comparison of two result sets. */
const canonical = (rows: ReadonlyArray<Record<string, unknown>>): string =>
	JSON.stringify([...rows].map((row) => JSON.stringify(row)).sort())

/**
 * The reader contract, written out once: plain `sum`/`min`/`max` for the
 * SimpleAggregateFunction columns, `uniqCombinedMerge(12)` for the states, an
 * explicit `GROUP BY`, and no `FINAL` anywhere.
 */
const ROLLUP_READ_SQL = `SELECT
  OrgId,
  ServiceName,
  AiVendor,
  toString(Hour) AS Hour,
  sum(SpanCount) AS SpanCount,
  sum(WeightedSpanCount) AS WeightedSpanCount,
  sum(EligibleSpanCount) AS EligibleSpanCount,
  sum(KeyAbsentCount) AS KeyAbsentCount,
  sum(KeyInvalidCount) AS KeyInvalidCount,
  sum(KeySubSessionCount) AS KeySubSessionCount,
  sum(KeySessionCount) AS KeySessionCount,
  uniqCombinedMerge(12)(TracesTotal) AS TracesTotal,
  uniqCombinedMerge(12)(TracesWithKey) AS TracesWithKey,
  uniqCombinedMerge(12)(SessionsApprox) AS SessionsApprox,
  min(RowRulesVersionMin) AS RowRulesVersionMin,
  max(RowRulesVersionMax) AS RowRulesVersionMax,
  max(RollupRulesVersion) AS RollupRulesVersion
FROM service_ai_vendors_hourly
GROUP BY OrgId, ServiceName, AiVendor, Hour
ORDER BY OrgId, ServiceName, AiVendor, Hour`

/**
 * The same numbers computed straight off `traces`. Identical expressions to the
 * MV's, but evaluated at read time over the raw spans — so agreement means the
 * MV's write-time evaluation and the state/merge round-trip preserved every
 * value, and disagreement localizes to whichever column moved.
 */
const RAW_READ_SQL = `SELECT
  OrgId,
  ServiceName,
  AiVendor,
  toString(AiRollupHour) AS Hour,
  count() AS SpanCount,
  sum(if(SampleRate > 0, SampleRate, 1.0)) AS WeightedSpanCount,
  countIf(AiSessionKeyState >= 3) AS EligibleSpanCount,
  countIf(AiSessionKeyState = 3) AS KeyAbsentCount,
  countIf(AiSessionKeyState = 4) AS KeyInvalidCount,
  countIf(AiSessionKeyState = 5) AS KeySubSessionCount,
  countIf(AiSessionKeyState = 6) AS KeySessionCount,
  uniqCombined(12)(TraceId) AS TracesTotal,
  uniqCombinedIf(12)(TraceId, AiSessionKeyState = 6) AS TracesWithKey,
  uniqCombinedIf(12)(AiSessionKeyHash, AiSessionKeyState = 6) AS SessionsApprox,
  min(AiRulesVersion) AS RowRulesVersionMin,
  max(AiRulesVersion) AS RowRulesVersionMax,
  max(AiRulesVersion) AS RollupRulesVersion
FROM traces
WHERE AiVendor != ''
GROUP BY OrgId, ServiceName, AiVendor, AiRollupHour
ORDER BY OrgId, ServiceName, AiVendor, Hour`

describe.skipIf(!clickhouseE2eEnabled)("service_ai_vendors_hourly rollup", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)

		// Three separate INSERTs over overlapping keys, on purpose: each one lands
		// its own part, so every rollup key has several unmerged rows and a reader
		// that skips the GROUP BY reads low instead of accidentally passing.
		for (const batch of AI_BATCHES) await insertBatch(batch)
		await insertBatch(SEED_NON_AI)
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("creates the rollup table and its materialized view from the real migrations", async () => {
		const recorded = await runJson("SELECT count() AS n FROM _maple_schema_migrations WHERE version = 16")
		assert.strictEqual(num(recorded[0]?.n), 1, "migration 16 was not recorded")

		const objects = await runJson(
			`SELECT name, engine
			 FROM system.tables
			 WHERE database = currentDatabase()
			   AND name IN ('service_ai_vendors_hourly', 'service_ai_vendors_hourly_mv')
			 ORDER BY name`,
		)
		assert.deepStrictEqual(
			objects.map((row) => [String(row.name), String(row.engine)]),
			[
				["service_ai_vendors_hourly", "AggregatingMergeTree"],
				["service_ai_vendors_hourly_mv", "MaterializedView"],
			],
		)

		// State types are not cast-compatible, so a widened or narrowed value type
		// is a silent data loss rather than an error at write time.
		const columns = await runJson(
			`SELECT name, type
			 FROM system.columns
			 WHERE database = currentDatabase()
			   AND table = 'service_ai_vendors_hourly'
			   AND name IN ('OrgId', 'Hour', 'TracesTotal', 'TracesWithKey', 'SessionsApprox')
			 ORDER BY name`,
		)
		assert.deepStrictEqual(
			Object.fromEntries(columns.map((row) => [String(row.name), String(row.type)])),
			{
				Hour: "DateTime('UTC')",
				// Must match traces.OrgId exactly.
				OrgId: "LowCardinality(String)",
				SessionsApprox: "AggregateFunction(uniqCombined(12), UInt64)",
				TracesTotal: "AggregateFunction(uniqCombined(12), String)",
				TracesWithKey: "AggregateFunction(uniqCombined(12), String)",
			},
		)
	})

	it("the seed lands, and lands as several unmerged parts per key", async () => {
		// The guard against a vacuous suite: two empty result sets satisfy every
		// equality below, and a TTL-expired seed produces exactly that.
		const raw = await runJson("SELECT count() AS n FROM traces WHERE AiVendor != ''")
		assert.strictEqual(
			num(raw[0]?.n),
			AI_SPANS_INSERTED,
			"the AI span seed did not land — check the rows against the traces 30-day TTL",
		)

		// If merges have already collapsed everything, the no-FINAL assertions below
		// would pass without proving anything.
		const parts = await runJson(
			`SELECT count() AS rows, uniqExact((OrgId, ServiceName, AiVendor, Hour)) AS keys
			 FROM service_ai_vendors_hourly`,
		)
		assert.isAbove(
			num(parts[0]?.rows),
			num(parts[0]?.keys),
			"every rollup key was already merged to one row — the multi-part reader assertions are vacuous",
		)
	})

	it("keeps the eligibility identity: Eligible = Absent + Invalid + SubSession + Session", async () => {
		// The plan's CI assertion. Checked per group and in total, because a
		// per-group break can cancel out in the total and vice versa.
		const violations = await runJson(
			`SELECT count() AS n FROM (
			   ${ROLLUP_READ_SQL}
			 )
			 WHERE EligibleSpanCount != KeyAbsentCount + KeyInvalidCount + KeySubSessionCount + KeySessionCount`,
		)
		assert.strictEqual(num(violations[0]?.n), 0, "the eligibility identity broke for at least one group")

		const totals = await runJson(
			`SELECT
			   sum(EligibleSpanCount) AS eligible,
			   sum(KeyAbsentCount + KeyInvalidCount + KeySubSessionCount + KeySessionCount) AS parts,
			   sum(SpanCount) AS spans
			 FROM service_ai_vendors_hourly`,
		)
		assert.strictEqual(num(totals[0]?.eligible), num(totals[0]?.parts))
		// States 0-2 are AI spans that were never eligible; if this were an equality
		// the fixture would have stopped covering the ineligible half of the enum.
		assert.isBelow(
			num(totals[0]?.eligible),
			num(totals[0]?.spans),
			"the fixture no longer contains ineligible AI spans",
		)
	})

	it("excludes non-AI spans entirely rather than writing zero rows", async () => {
		const rollupSpans = await runJson("SELECT sum(SpanCount) AS n FROM service_ai_vendors_hourly")
		const rawAiSpans = await runJson("SELECT count() AS n FROM traces WHERE AiVendor != ''")
		assert.strictEqual(num(rollupSpans[0]?.n), num(rawAiSpans[0]?.n))

		const emptyVendor = await runJson(
			"SELECT count() AS n FROM service_ai_vendors_hourly WHERE AiVendor = ''",
		)
		assert.strictEqual(num(emptyVendor[0]?.n), 0, "non-AI spans produced rollup rows")

		// The state-6 non-AI span in the fixture: it must not have contributed a
		// session, which is what an MV filtering on state instead of vendor would do.
		const sessions = await runJson(
			`SELECT uniqCombinedMerge(12)(SessionsApprox) AS n
			 FROM service_ai_vendors_hourly`,
		)
		const expectedSessions = new Set(
			SEED_SPANS.filter((row) => row.state === 6).map((row) => row.keyHash),
		).size
		assert.strictEqual(
			num(sessions[0]?.n),
			expectedSessions,
			"a non-AI span's session key leaked into SessionsApprox",
		)
	})

	it("floors zero and defaulted SampleRate to 1.0 and keeps WeightedSpanCount finite", async () => {
		const worker = await runJson(
			`SELECT sum(WeightedSpanCount) AS weighted, sum(SpanCount) AS spans
			 FROM service_ai_vendors_hourly
			 WHERE OrgId = ${quote(ORG_A)} AND ServiceName = 'worker'`,
		)
		// One span at 4.0, one at 0 (floors to 1.0), one with the column omitted so
		// the table's DEFAULT computed it — which for an unsampled span is 1.0.
		assert.strictEqual(num(worker[0]?.spans), 3)
		assert.strictEqual(num(worker[0]?.weighted), 6)

		const finite = await runJson(
			`SELECT count() AS n
			 FROM service_ai_vendors_hourly
			 WHERE NOT isFinite(WeightedSpanCount) OR WeightedSpanCount <= 0`,
		)
		assert.strictEqual(num(finite[0]?.n), 0, "WeightedSpanCount went non-finite or non-positive")
	})

	it("groups on the stored AiRollupHour, not the span timestamp", async () => {
		const hours = await runJson(
			`SELECT DISTINCT toString(Hour) AS h FROM service_ai_vendors_hourly ORDER BY h`,
		)
		assert.deepStrictEqual(
			hours.map((row) => String(row.h)),
			[hour(0), hour(1), hour(2)],
		)

		// Every seeded span's Timestamp sits a minute into its hour, so a
		// toStartOfHour(Timestamp) regression would produce identical hours here.
		// Pin the column instead: no rollup hour may disagree with the stored one.
		const drift = await runJson(
			`SELECT count() AS n FROM (
			   SELECT DISTINCT AiRollupHour AS h FROM traces WHERE AiVendor != ''
			 ) AS raw
			 LEFT ANTI JOIN (
			   SELECT DISTINCT Hour AS h FROM service_ai_vendors_hourly
			 ) AS rollup USING (h)`,
		)
		assert.strictEqual(num(drift[0]?.n), 0, "a stored AiRollupHour has no matching rollup hour")
	})

	it("reads trace coverage by merging across vendor rows, not per vendor", async () => {
		// The plan's worked example. `trace-mix` carries a langchain span with a
		// session key and a litellm span without one.
		const perVendor = await runJson(
			`SELECT
			   AiVendor,
			   uniqCombinedMerge(12)(TracesTotal) AS total,
			   uniqCombinedMerge(12)(TracesWithKey) AS withKey
			 FROM service_ai_vendors_hourly
			 WHERE OrgId = ${quote(ORG_A)} AND ServiceName = 'checkout' AND Hour = ${quote(hour(0))}
			   AND AiVendor IN ('langchain', 'litellm')
			 GROUP BY AiVendor
			 ORDER BY AiVendor`,
		)
		assert.deepStrictEqual(
			perVendor.map((row) => [String(row.AiVendor), num(row.total), num(row.withKey)]),
			[
				["langchain", 1, 1],
				// The diagnostic-only reading: 0% on a trace that is in fact fully
				// resolvable. Asserting it pins *why* per-vendor ratios are not the
				// headline, so nobody promotes them later.
				["litellm", 1, 0],
			],
		)

		// The headline: merge the same states across both vendor rows and the trace
		// is covered exactly once.
		const merged = await runJson(
			`SELECT
			   uniqCombinedMerge(12)(TracesTotal) AS total,
			   uniqCombinedMerge(12)(TracesWithKey) AS withKey
			 FROM service_ai_vendors_hourly
			 WHERE OrgId = ${quote(ORG_A)} AND ServiceName = 'checkout' AND Hour = ${quote(hour(0))}
			   AND AiVendor IN ('langchain', 'litellm')`,
		)
		assert.strictEqual(num(merged[0]?.total), 1)
		assert.strictEqual(num(merged[0]?.withKey), 1)
	})

	it("counts a trace once per hour and once overall when it straddles hours", async () => {
		// `trace-dup` appears in two hours. Each hour sees it; merging the hours
		// must not double it — uniq merge is set union, which is the property the
		// cross-shard note in the plan also depends on.
		const perHour = await runJson(
			`SELECT toString(Hour) AS h, uniqCombinedMerge(12)(TracesTotal) AS total
			 FROM service_ai_vendors_hourly
			 WHERE OrgId = ${quote(ORG_A)} AND ServiceName = 'checkout' AND AiVendor = 'openai'
			 GROUP BY Hour
			 ORDER BY Hour`,
		)
		assert.deepStrictEqual(
			perHour.map((row) => [String(row.h), num(row.total)]),
			[
				// Hour 0 also carries the per-state fixture traces.
				[hour(0), 8],
				[hour(1), 1],
			],
		)

		const merged = await runJson(
			`SELECT uniqCombinedMerge(12)(TracesTotal) AS total
			 FROM service_ai_vendors_hourly
			 WHERE OrgId = ${quote(ORG_A)} AND ServiceName = 'checkout' AND AiVendor = 'openai'`,
		)
		assert.strictEqual(num(merged[0]?.total), 8, "the straddling trace was double-counted across hours")
	})

	it("carries a session-key hash above 2^53 without corrupting it", async () => {
		const hashes = await runJson(
			`SELECT toString(AiSessionKeyHash) AS h
			 FROM traces
			 WHERE AiVendor != '' AND TraceId = 'trace-s6'
			 LIMIT 1`,
		)
		assert.strictEqual(String(hashes[0]?.h), BIG_HASH, "the >2^53 hash was corrupted on the raw table")

		// And it is a distinct session, not collapsed into a neighbour by a
		// float round-trip through the HLL state.
		const sessions = await runJson(
			`SELECT uniqCombinedMerge(12)(SessionsApprox) AS n
			 FROM service_ai_vendors_hourly
			 WHERE OrgId = ${quote(ORG_A)} AND ServiceName = 'checkout' AND AiVendor = 'openai'`,
		)
		// trace-dup's 202, trace-s6's big hash — trace-s5 is state 5, which does not
		// feed SessionsApprox.
		assert.strictEqual(num(sessions[0]?.n), 2)
	})

	it("reports rule versions as row provenance, with RollupRulesVersion equal by construction", async () => {
		const versions = await runJson(
			`SELECT
			   min(RowRulesVersionMin) AS lo,
			   max(RowRulesVersionMax) AS hi,
			   max(RollupRulesVersion) AS rollup
			 FROM service_ai_vendors_hourly
			 WHERE OrgId = ${quote(ORG_B)} AND ServiceName = 'checkout' AND AiVendor = 'langchain'`,
		)
		// Two spans written by v8 and v9 in the same group: the range is visible
		// rather than collapsed to one number.
		assert.strictEqual(num(versions[0]?.lo), 8)
		assert.strictEqual(num(versions[0]?.hi), 9)
		// For MV-written rows this always equals RowRulesVersionMax; divergence is
		// the signal that a partition was rebuilt by a later registry version.
		assert.strictEqual(num(versions[0]?.rollup), num(versions[0]?.hi))
	})

	it("agrees with the same aggregates computed straight off traces", async () => {
		const [rollupRows, rawRows] = await Promise.all([runJson(ROLLUP_READ_SQL), runJson(RAW_READ_SQL)])

		assert.isNotEmpty(rawRows, "the parity fixture produced no raw groups")
		assert.strictEqual(
			rollupRows.length,
			rawRows.length,
			"the rollup and the raw table disagree on how many (org, service, vendor, hour) groups exist",
		)
		assert.strictEqual(canonical(rollupRows), canonical(rawRows))
	})

	it("does not need FINAL, and a reader that skips the GROUP BY reads low", async () => {
		// Stated as a property rather than a style rule: the contract is that
		// aggregating without FINAL is correct, and that the unaggregated read is
		// wrong — which is what makes the GROUP BY mandatory rather than decorative.
		const aggregated = await runJson("SELECT sum(SpanCount) AS n FROM service_ai_vendors_hourly")
		const naive = await runJson(
			`SELECT SpanCount AS n
			 FROM service_ai_vendors_hourly
			 ORDER BY SpanCount DESC
			 LIMIT 1`,
		)
		assert.isAbove(
			num(aggregated[0]?.n),
			num(naive[0]?.n),
			"a single unaggregated row already carried the total — the fixture stopped exercising multiple parts",
		)

		// FINAL must be unnecessary, not merely discouraged: same answer either way.
		const withFinal = await runJson("SELECT sum(SpanCount) AS n FROM service_ai_vendors_hourly FINAL")
		assert.strictEqual(num(aggregated[0]?.n), num(withFinal[0]?.n))
	})
})
