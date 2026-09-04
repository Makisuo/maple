import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import {
	aggregate,
	benchmarkSql,
	BenchmarkError,
	canonicalJson,
	compareRuns,
	explainSql,
	metricNumber,
	percentile,
	RunOutput,
	runSuite,
	validateReplaySql,
	validateSuite,
	type BenchmarkTransport,
	type RunMetrics,
	type Sample,
	type Suite,
} from "./index"

const sample = (id: string): Sample => ({
	id,
	inputs: "fixed-inputs",
	fingerprint: "old-fingerprint",
	context: id,
	profile: "",
	sampleSql: `SELECT '${id}'`,
})
const suite: Suite = { source: "test", samples: [sample("a"), sample("b")] }
const metrics = (wallMs = 10): RunMetrics => ({
	queryId: "query",
	wallMs,
	serverElapsedMs: wallMs,
	readRows: 100,
	readBytes: 1000,
	memoryUsage: 500,
	resultRows: 1,
	profileEvents: {},
	metricSource: "query_log",
	resultHash: "same",
})
const report = (wallMs = 10): RunOutput => ({
	version: 1,
	ranAt: "2026-09-01",
	target: "http://localhost:8123",
	database: "default",
	serverVersion: "26.2",
	dataset: "snapshot-1",
	sourceFile: "suite.json",
	source: "test",
	runsPerQuery: 2,
	warmupRuns: 1,
	settings: { max_threads: "1" },
	verifyResults: true,
	resultOrder: "unordered",
	warnings: [],
	results: [
		{
			id: "a",
			inputs: "fixed-inputs",
			fingerprint: "old-fingerprint",
			context: "a",
			profile: "",
			sql: "SELECT 1",
			runs: [metrics(wallMs), metrics(wallMs)],
			aggregates: aggregate([metrics(wallMs), metrics(wallMs)]),
		},
	],
})
const compare = (a: RunOutput, b: RunOutput) =>
	compareRuns(a, b, { metric: "p95WallMs", thresholdPercent: 10, minDelta: 1 })

describe("benchmark evidence", () => {
	it("uses nearest rank and nulls for missing measurements", () => {
		expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3)
		expect(percentile([1, 2, 3, 4, 5], 95)).toBe(5)
		expect(aggregate([]).p95WallMs).toBeNull()
		expect(aggregate([metrics(1), metrics(3)]).stddevWallMs).toBeCloseTo(Math.SQRT2)
		expect([null, "", "NaN", "Infinity", -1, {}].map(metricNumber)).toEqual([
			null,
			null,
			null,
			null,
			null,
			null,
		])
		expect(metricNumber("0")).toBe(0)
	})
	it("validates report versions and numeric metrics", () => {
		const decode = Schema.decodeUnknownOption(RunOutput)
		expect(decode(report())._tag).toBe("Some")
		expect(decode({ ...report(), version: 2 })._tag).toBe("None")
		expect(decode({ ...report(), runsPerQuery: 0 })._tag).toBe("None")
		expect(
			decode({ ...report(), results: [{ ...report().results[0], runs: [metrics(Number.NaN)] }] })._tag,
		).toBe("None")
	})
	it("matches a rewritten SQL shape by case ID", () => {
		const before = report(100)
		const after = report(50)
		const candidate = {
			...after,
			results: after.results.map((r) => ({
				...r,
				sql: "SELECT optimized()",
				fingerprint: "new-fingerprint",
			})),
		}
		expect(compare(before, candidate).rows[0]).toMatchObject({
			status: "ok",
			sqlChanged: true,
			percent: -50,
		})
	})
	it("requires both relative and absolute regression thresholds, including zero baselines", () => {
		expect(compare(report(10), report(10.5)).failed).toBe(false)
		expect(compare(report(10), report(12)).rows[0]?.status).toBe("regression")
		expect(compare(report(0), report(2)).rows[0]).toMatchObject({ status: "regression", percent: null })
	})
	it("never reports a missing, failed, or new case as a passing comparison", () => {
		expect(compare(report(), { ...report(), results: [] }).rows[0]?.status).toBe("missing")
		expect(
			compare(report(), {
				...report(),
				results: report().results.map((r) => ({ ...r, error: "timeout" })),
			}).rows[0]?.status,
		).toBe("failed")
		expect(compare({ ...report(), results: [] }, report()).rows[0]?.status).toBe("added")
	})
	it("rejects mismatched environments, inputs, and incomplete iterations", () => {
		expect(compare(report(), { ...report(), dataset: "new-data" }).rows[0]?.status).toBe("incompatible")
		expect(compare(report(), { ...report(), settings: { max_threads: "2" } }).rows[0]?.status).toBe(
			"incompatible",
		)
		expect(
			compare(report(), {
				...report(),
				results: report().results.map((r) => ({ ...r, inputs: "different-tenant" })),
			}).rows[0]?.status,
		).toBe("incompatible")
		expect(
			compare(report(), { ...report(), results: report().results.map((r) => ({ ...r, runs: [] })) })
				.rows[0]?.status,
		).toBe("failed")
	})
	it("rejects different or unstable result hashes", () => {
		const candidate = {
			...report(),
			results: report().results.map((r) => ({
				...r,
				runs: [metrics(), { ...metrics(), resultHash: "changed" }],
			})),
		}
		expect(compare(report(), candidate).rows[0]?.status).toBe("result-mismatch")
	})
	it("reports unavailable memory instead of treating it as zero", () => {
		const candidate = {
			...report(),
			results: report().results.map((r) => ({
				...r,
				aggregates: { ...r.aggregates, meanMemoryUsage: null },
			})),
		}
		expect(
			compareRuns(report(), candidate, { metric: "meanMemoryUsage", thresholdPercent: 10, minDelta: 0 })
				.rows[0]?.status,
		).toBe("unavailable")
	})

	it("rejects partially missing metrics even when an aggregate exists", () => {
		const candidate = {
			...report(),
			results: report().results.map((r) => ({
				...r,
				runs: [metrics(), { ...metrics(), memoryUsage: null }],
			})),
		}
		expect(
			compareRuns(report(), candidate, { metric: "meanMemoryUsage", thresholdPercent: 10, minDelta: 0 })
				.rows[0]?.status,
		).toBe("unavailable")
		expect(compare({ ...report(), results: [] }, { ...report(), results: [] }).failed).toBe(true)
	})
	it("canonicalizes object keys while preserving array order and duplicate rows", () => {
		expect(canonicalJson({ b: [1, 1, 2], a: 1 })).toBe(canonicalJson({ a: 1, b: [1, 1, 2] }))
		expect(canonicalJson([1, 1, 2])).not.toBe(canonicalJson([1, 2]))
	})
})

describe("benchmark SQL", () => {
	it("preserves nested and quoted terminal keywords when replacing a format", () => {
		const sql =
			"SELECT 'FORMAT JSON' AS x FROM (SELECT 1 SETTINGS max_threads=2) SETTINGS max_threads=4 FORMAT JSON;"
		const replay = benchmarkSql(sql, { max_threads: "1" }, "JSONEachRow")
		expect(replay).toContain("(SELECT 1 SETTINGS max_threads=2)")
		expect(replay).toContain("SETTINGS max_threads=4\n, max_threads=1\nFORMAT JSONEachRow")
		expect(explainSql(sql, "indexes")).toContain("EXPLAIN indexes = 1, projections = 1")
		expect(explainSql(sql, "indexes")).toContain("use_skip_indexes_on_data_read=0")
		expect(explainSql(sql, "pipeline")).toContain("FORMAT TabSeparatedRaw")
	})
	it("keeps trailing comments from swallowing benchmark controls", () => {
		const replay = benchmarkSql(
			"SELECT 1 SETTINGS max_threads=4; -- original setting",
			{ max_threads: "1" },
			"JSONEachRow",
		)
		expect(replay).toContain("-- original setting\n, max_threads=1\nFORMAT JSONEachRow")
		expect(replay).not.toContain(";")
	})
	it("accepts comments and literal semicolons but rejects writes and multiple statements", async () => {
		await expect(
			Effect.runPromise(validateReplaySql("/* intro */ WITH 1 AS x SELECT ';' AS a; -- end")),
		).resolves.toBeTypeOf("string")
		for (const sql of [
			"DROP TABLE foo",
			"SELECT 1; DROP TABLE foo",
			"SELECT 1 INTO OUTFILE '/tmp/result'",
		]) {
			await expect(Effect.runPromise(validateReplaySql(sql))).rejects.toThrow("single SELECT/WITH")
		}
	})
})

describe("benchmark runner", () => {
	it("rotates serial rounds, excludes warmups, then collects all logs once", async () => {
		const calls: string[] = []
		const logBatches: ReadonlyArray<string>[] = []
		let counter = 0
		const transport: BenchmarkTransport = {
			execute: (sql) =>
				Effect.sync(() => {
					calls.push(sql)
					counter++
					return {
						queryId: String(counter),
						wallMs: counter,
						summary: { elapsed_ns: "1000000", read_rows: "100" },
					}
				}),
			collectLogs: (ids) =>
				Effect.sync(() => {
					logBatches.push(ids)
					expect(calls).toHaveLength(6)
					return { entries: [], warnings: [] }
				}),
		}
		const result = await Effect.runPromise(
			runSuite(transport, suite, { runs: 2, warmup: 1, settings: {}, verifyResults: false }),
		)
		expect(calls).toEqual([
			"SELECT 'a'",
			"SELECT 'b'",
			"SELECT 'b'",
			"SELECT 'a'",
			"SELECT 'a'",
			"SELECT 'b'",
		])
		expect(logBatches).toEqual([["4", "5", "3", "6"]])
		expect(result.results[0]?.runs.map((r) => r.wallMs)).toEqual([4, 5])
		expect(result.results[0]?.runs[0]).toMatchObject({
			serverElapsedMs: 1,
			readRows: 100,
			memoryUsage: null,
			metricSource: "summary",
		})
		expect(result.warnings.join()).toContain("4/4 query logs unavailable")
	})
	it("validates all cases before any execution", async () => {
		let count = 0
		const transport: BenchmarkTransport = {
			execute: () =>
				Effect.sync(() => {
					count++
					return { queryId: "x", wallMs: 1, summary: {} }
				}),
			collectLogs: () => Effect.succeed({ entries: [], warnings: [] }),
		}
		await expect(
			Effect.runPromise(
				runSuite(
					transport,
					{ ...suite, samples: [sample("a"), { ...sample("b"), sampleSql: "DROP TABLE data" }] },
					{ runs: 1, warmup: 0, settings: {}, verifyResults: false },
				),
			),
		).rejects.toThrow()
		await expect(
			Effect.runPromise(
				runSuite(transport, suite, { runs: 0, warmup: 0, settings: {}, verifyResults: false }),
			),
		).rejects.toThrow()
		await expect(
			Effect.runPromise(validateSuite({ ...suite, samples: [sample("a"), sample("a")] })),
		).rejects.toThrow()
		expect(count).toBe(0)
	})
	it("keeps partial measurements on failure and continues other cases", async () => {
		let aCalls = 0
		const transport: BenchmarkTransport = {
			execute: (sql) =>
				Effect.suspend(() => {
					if (sql.includes("'a'") && ++aCalls === 2)
						return Effect.fail(new BenchmarkError({ message: "query timeout" }))
					return Effect.succeed({ queryId: `${sql}-${aCalls}`, wallMs: 1, summary: {} })
				}),
			collectLogs: () => Effect.fail(new BenchmarkError({ message: "log access denied" })),
		}
		const result = await Effect.runPromise(
			runSuite(transport, suite, { runs: 3, warmup: 0, settings: {}, verifyResults: false }),
		)
		expect(result.results[0]).toMatchObject({ error: "query timeout" })
		expect(result.results[0]?.runs).toHaveLength(1)
		expect(result.results[1]?.runs).toHaveLength(3)
		expect(result.warnings).toContain("log access denied")
	})
})
