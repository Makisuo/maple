import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { QueryEngineResult } from "@maple/domain/query-engine"
import type { QueryBuilderQueryDraftPayload, QuerySet } from "@maple/query-model"
import { LAB_EMPTY_RANGE_STRATEGY } from "./bucketing"
import type { QuerySetExecutor, QuerySetExecuteRequest } from "./port"
import { runTimeseriesQuerySet } from "./timeseries"
import { runQuerySetWindow } from "./window"

/**
 * The runner is defined entirely by what it asks a `QuerySetExecutor` for and
 * what it does with the answers, so these tests drive it with an in-memory one.
 * No HTTP, no warehouse — which is the point of the port existing.
 */
class FakeError {
	constructor(readonly message: string) {}
}

type FakeResponse =
	| { readonly _tag: "ok"; readonly result: QueryEngineResult }
	| { readonly _tag: "fail"; readonly error: FakeError }

/** A successful timeseries answer carrying these points. */
const ok = (points: ReadonlyArray<{ bucket: string; series: Record<string, number> }>): FakeResponse => ({
	_tag: "ok",
	result: { kind: "timeseries", source: "traces", data: points },
})

/** Any other result shape — the "host answered a different question" case. */
const raw = (result: QueryEngineResult): FakeResponse => ({ _tag: "ok", result })

const fail = (message: string): FakeResponse => ({ _tag: "fail", error: new FakeError(message) })

const makeExecutor = (respond: (request: QuerySetExecuteRequest) => FakeResponse) => {
	const requests: QuerySetExecuteRequest[] = []
	const executor: QuerySetExecutor<FakeError> = {
		execute: (request) =>
			Effect.suspend((): Effect.Effect<QueryEngineResult, FakeError> => {
				requests.push(request)
				const response = respond(request)
				return response._tag === "fail"
					? Effect.fail(response.error)
					: Effect.succeed(response.result)
			}),
		describeError: (error) => error.message,
	}
	return { executor, requests }
}

const draft = (overrides: Partial<QueryBuilderQueryDraftPayload> = {}): QueryBuilderQueryDraftPayload =>
	({
		id: "q-1",
		name: "A",
		dataSource: "traces",
		aggregation: "count",
		...overrides,
	}) as QueryBuilderQueryDraftPayload

const set = (overrides: Partial<QuerySet> = {}): QuerySet => ({
	queries: [draft()],
	...overrides,
})

const WINDOW = { startTime: "2026-01-02 00:00:00", endTime: "2026-01-02 01:00:00" }

const point = (bucket: string, series: Record<string, number>) => ({ bucket, series })

const isLogs = (request: QuerySetExecuteRequest) =>
	request.query.kind === "timeseries" && request.query.source === "logs"

describe("runQuerySetWindow", () => {
	it.effect("issues one execute per query and folds a build failure without executing it", () =>
		Effect.gen(function* () {
			const { executor, requests } = makeExecutor(() =>
				ok([point("2026-01-02T00:00:00.000Z", { all: 1 })]),
			)

			const result = yield* runQuerySetWindow(executor, {
				queries: [
					draft({ id: "ok", name: "OK" }),
					// An empty aggregation cannot be lowered, so this never reaches the
					// executor — it becomes an error result instead.
					draft({ id: "bad", name: "Bad", aggregation: "" }),
				],
				formulas: [],
				...WINDOW,
			})

			assert.strictEqual(requests.length, 1)
			assert.strictEqual(result.queryResults.length, 2)
			assert.strictEqual(result.queryResults[0].status, "success")
			assert.strictEqual(result.queryResults[1].status, "error")
			// A build failure records a diagnostic with no spec, which is how a debug
			// panel tells "never ran" apart from "ran and failed".
			assert.isNull(result.diagnostics.find((d) => d.queryId === "bad")?.spec ?? null)
		}),
	)

	it.effect("folds a warehouse failure into that query's status, leaving siblings alone", () =>
		Effect.gen(function* () {
			const { executor } = makeExecutor((request) =>
				isLogs(request) ? fail("logs are down") : ok([point("2026-01-02T00:00:00.000Z", { all: 3 })]),
			)

			const result = yield* runQuerySetWindow(executor, {
				queries: [draft({ id: "t" }), draft({ id: "l", dataSource: "logs" })],
				formulas: [],
				...WINDOW,
			})

			assert.strictEqual(result.queryResults[0].status, "success")
			assert.strictEqual(result.queryResults[1].status, "error")
			assert.strictEqual(result.queryResults[1].error, "logs are down")
		}),
	)

	it.effect("treats a non-timeseries result as no data rather than crashing the set", () =>
		Effect.gen(function* () {
			const { executor } = makeExecutor(() => raw({ kind: "breakdown", source: "traces", data: [] }))

			const result = yield* runQuerySetWindow(executor, {
				queries: [draft()],
				formulas: [],
				...WINDOW,
			})

			assert.strictEqual(result.queryResults[0].status, "success")
			assert.deepStrictEqual(result.queryResults[0].data, [])
		}),
	)

	it.effect("does not evaluate formulas when no query returned data", () =>
		Effect.gen(function* () {
			const { executor } = makeExecutor(() => ok([]))

			const result = yield* runQuerySetWindow(executor, {
				queries: [draft({ id: "q-1", name: "A" })],
				formulas: [{ id: "f-1", name: "F", expression: "A * 2", legend: "" }],
				...WINDOW,
			})

			assert.lengthOf(result.formulaResults, 0)
		}),
	)

	it.effect("does not widen by default — only when a strategy is passed", () =>
		Effect.gen(function* () {
			const noFallback = makeExecutor(() => ok([]))
			yield* runQuerySetWindow(noFallback.executor, { queries: [draft()], formulas: [], ...WINDOW })
			assert.strictEqual(noFallback.requests.length, 1)

			const withFallback = makeExecutor(() => ok([]))
			yield* runQuerySetWindow(withFallback.executor, {
				queries: [draft()],
				formulas: [],
				...WINDOW,
				fallback: LAB_EMPTY_RANGE_STRATEGY,
			})
			// primary + 24h + 7d + 31d
			assert.strictEqual(withFallback.requests.length, 4)
		}),
	)

	it.effect("skips a failing fallback window rather than failing the query", () =>
		Effect.gen(function* () {
			// The caller asked about the primary window; a speculative widening that
			// is too expensive must not turn a working chart into an error.
			const { executor } = makeExecutor((request) =>
				request.startTime === WINDOW.startTime
					? ok([])
					: request.startTime === "2026-01-01 01:00:00"
						? fail("too expensive")
						: ok([point("2026-01-01T00:00:00.000Z", { all: 5 })]),
			)

			const result = yield* runQuerySetWindow(executor, {
				queries: [draft()],
				formulas: [],
				...WINDOW,
				fallback: LAB_EMPTY_RANGE_STRATEGY,
			})

			assert.strictEqual(result.queryResults[0].status, "success")
			assert.isTrue(result.diagnostics[0].fallbackUsed)
			assert.include(result.queryResults[0].warnings.join(" "), "used fallback window")
		}),
	)

	it.effect("stops at the primary window when IT fails — that is not a widening case", () =>
		Effect.gen(function* () {
			const { executor, requests } = makeExecutor(() => fail("boom"))

			const result = yield* runQuerySetWindow(executor, {
				queries: [draft()],
				formulas: [],
				...WINDOW,
				fallback: LAB_EMPTY_RANGE_STRATEGY,
			})

			assert.strictEqual(requests.length, 1)
			assert.strictEqual(result.queryResults[0].status, "error")
			assert.strictEqual(result.queryResults[0].error, "boom")
		}),
	)
})

describe("runTimeseriesQuerySet", () => {
	it.effect("merges a multi-query set into bucket rows", () =>
		Effect.gen(function* () {
			const { executor } = makeExecutor((request) =>
				isLogs(request)
					? ok([point("2026-01-02T00:00:00.000Z", { all: 7 })])
					: ok([point("2026-01-02T00:00:00.000Z", { all: 3 })]),
			)

			const result = yield* runTimeseriesQuerySet(executor, {
				querySet: set({
					queries: [
						draft({ id: "t", name: "Traces" }),
						draft({ id: "l", name: "Logs", dataSource: "logs" }),
					],
				}),
				...WINDOW,
			})

			assert.deepStrictEqual(result.rows, [{ bucket: "2026-01-02T00:00:00.000Z", Traces: 3, Logs: 7 }])
		}),
	)

	it.effect("skips disabled queries but still runs hidden ones, so formulas keep their operands", () =>
		Effect.gen(function* () {
			const { executor, requests } = makeExecutor(() =>
				ok([point("2026-01-02T00:00:00.000Z", { all: 4 })]),
			)

			const result = yield* runTimeseriesQuerySet(executor, {
				querySet: set({
					queries: [
						draft({ id: "a", name: "A", hidden: true }),
						draft({ id: "b", name: "B", enabled: false }),
					],
					formulas: [{ id: "f", name: "F", expression: "A * 2", legend: "Doubled" }],
				}),
				...WINDOW,
			})

			// One execute: the disabled query never ran, the hidden one did.
			assert.strictEqual(requests.length, 1)
			// Only the formula is plotted — the hidden operand is dropped AFTER it fed
			// the formula, not before.
			assert.deepStrictEqual(result.rows, [{ bucket: "2026-01-02T00:00:00.000Z", Doubled: 8 }])
		}),
	)

	it.effect("fails with QuerySetInputError when the set has nothing enabled", () =>
		Effect.gen(function* () {
			const { executor } = makeExecutor(() => ok([]))
			const outcome = yield* Effect.result(
				runTimeseriesQuerySet(executor, {
					querySet: set({ queries: [draft({ enabled: false })] }),
					...WINDOW,
				}),
			)

			assert.isTrue(outcome._tag === "Failure")
			if (outcome._tag !== "Failure") return
			assert.strictEqual(outcome.failure._tag, "@maple/query-engine/query-set/QuerySetInputError")
		}),
	)

	it.effect("fails with QuerySetNoDataError when every query came back empty", () =>
		Effect.gen(function* () {
			const { executor } = makeExecutor(() => ok([]))
			const outcome = yield* Effect.result(
				runTimeseriesQuerySet(executor, { querySet: set(), ...WINDOW }),
			)

			assert.isTrue(outcome._tag === "Failure")
			if (outcome._tag !== "Failure") return
			assert.strictEqual(outcome.failure._tag, "@maple/query-engine/query-set/QuerySetNoDataError")
		}),
	)

	it.effect("reports the query's own error when the whole set failed", () =>
		Effect.gen(function* () {
			const { executor } = makeExecutor(() => fail("Timeseries query too expensive"))
			const outcome = yield* Effect.result(
				runTimeseriesQuerySet(executor, { querySet: set(), ...WINDOW }),
			)

			assert.isTrue(outcome._tag === "Failure")
			if (outcome._tag !== "Failure") return
			assert.include(String(outcome.failure.message), "too expensive")
		}),
	)

	it.effect("fails when data came back but every series with data is hidden", () =>
		Effect.gen(function* () {
			const { executor } = makeExecutor(() => ok([point("2026-01-02T00:00:00.000Z", { all: 4 })]))

			const outcome = yield* Effect.result(
				runTimeseriesQuerySet(executor, {
					querySet: set({ queries: [draft({ hidden: true })] }),
					...WINDOW,
				}),
			)

			assert.isTrue(outcome._tag === "Failure")
			if (outcome._tag !== "Failure") return
			assert.include(String(outcome.failure.message), "nothing to plot")
		}),
	)

	describe("previous_period comparison", () => {
		it.effect("runs a shifted window and appends (prev) and (%Δ) series", () =>
			Effect.gen(function* () {
				const { executor, requests } = makeExecutor((request) =>
					request.startTime === WINDOW.startTime
						? ok([point("2026-01-02T00:00:00.000Z", { all: 20 })])
						: ok([point("2026-01-01T23:00:00.000Z", { all: 10 })]),
				)

				const result = yield* runTimeseriesQuerySet(executor, {
					querySet: set({
						queries: [draft({ id: "q-1", name: "Requests" })],
						comparison: { mode: "previous_period", includePercentChange: true },
					}),
					...WINDOW,
				})

				assert.deepStrictEqual(
					requests.map((r) => r.startTime),
					[WINDOW.startTime, "2026-01-01 23:00:00"],
				)
				assert.deepStrictEqual(result.rows, [
					{
						bucket: "2026-01-02T00:00:00.000Z",
						Requests: 20,
						"Requests (prev)": 10,
						"Requests (%Δ)": 100,
					},
				])
				assert.strictEqual(result.diagnostics.comparison.previousStartTime, "2026-01-01 23:00:00")
			}),
		)

		it.effect("omits the percent-change series when the caller opts out", () =>
			Effect.gen(function* () {
				const { executor } = makeExecutor((request) =>
					request.startTime === WINDOW.startTime
						? ok([point("2026-01-02T00:00:00.000Z", { all: 20 })])
						: ok([point("2026-01-01T23:00:00.000Z", { all: 10 })]),
				)

				const result = yield* runTimeseriesQuerySet(executor, {
					querySet: set({
						queries: [draft({ id: "q-1", name: "Requests" })],
						comparison: { mode: "previous_period", includePercentChange: false },
					}),
					...WINDOW,
				})

				assert.notProperty(result.rows[0], "Requests (%Δ)")
			}),
		)

		/**
		 * Widening the comparison window would compare the requested period against
		 * a differently-sized one, which is a wrong answer rather than a missing one.
		 */
		it.effect("never widens the previous window, even when a fallback strategy is set", () =>
			Effect.gen(function* () {
				const { executor, requests } = makeExecutor((request) =>
					request.startTime === WINDOW.startTime
						? ok([point("2026-01-02T00:00:00.000Z", { all: 1 })])
						: ok([]),
				)

				yield* runTimeseriesQuerySet(executor, {
					querySet: set({ comparison: { mode: "previous_period" } }),
					...WINDOW,
					fallback: LAB_EMPTY_RANGE_STRATEGY,
				})

				// Primary succeeded on its first try, so the only other request is the
				// single un-widened previous window.
				assert.deepStrictEqual(
					requests.map((r) => r.startTime),
					[WINDOW.startTime, "2026-01-01 23:00:00"],
				)
			}),
		)
	})
})
