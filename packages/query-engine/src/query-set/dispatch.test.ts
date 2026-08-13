import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { QueryEngineResult } from "@maple/domain/query-engine"
import type { QueryBuilderQueryDraftPayload, QuerySet } from "@maple/query-model"
import { runBreakdownQuerySet } from "./breakdown"
import { runQuerySet } from "./dispatch"
import { QuerySetInputError, QuerySetNoDataError } from "./errors"
import { runListQuerySet } from "./list"
import type { QuerySetExecutor, QuerySetExecuteRequest } from "./port"

class FakeError {
	constructor(readonly message: string) {}
}

type FakeResponse =
	| { readonly _tag: "ok"; readonly result: QueryEngineResult }
	| { readonly _tag: "fail"; readonly error: FakeError }

const breakdown = (data: ReadonlyArray<{ name: string; value: number }>): FakeResponse => ({
	_tag: "ok",
	result: { kind: "breakdown", source: "traces", data },
})

const list = (data: ReadonlyArray<Record<string, unknown>>): FakeResponse => ({
	_tag: "ok",
	result: { kind: "list", source: "traces", data },
})

const timeseries = (
	data: ReadonlyArray<{ bucket: string; series: Record<string, number> }>,
): FakeResponse => ({
	_tag: "ok",
	result: { kind: "timeseries", source: "traces", data },
})

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

// A breakdown needs a real group-by dimension, and the lowering only reads
// `groupBy` when its add-on is switched on — the same gate the builder UI uses.
const draft = (overrides: Partial<QueryBuilderQueryDraftPayload> = {}): QueryBuilderQueryDraftPayload =>
	({
		id: "q-1",
		name: "A",
		dataSource: "traces",
		aggregation: "count",
		groupBy: ["service"],
		addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
		...overrides,
	}) as QueryBuilderQueryDraftPayload

const set = (overrides: Partial<QuerySet> = {}): QuerySet => ({ queries: [draft()], ...overrides })

const WINDOW = { startTime: "2026-01-02 00:00:00", endTime: "2026-01-02 01:00:00" }

describe("runBreakdownQuerySet", () => {
	it.effect("merges two queries into one row per name", () =>
		Effect.gen(function* () {
			const { executor } = makeExecutor((request) =>
				request.query.kind === "breakdown" && request.query.source === "logs"
					? breakdown([{ name: "api", value: 5 }])
					: breakdown([{ name: "api", value: 9 }]),
			)

			const result = yield* runBreakdownQuerySet(executor, {
				querySet: set({
					queries: [
						draft({ id: "t", name: "Traces" }),
						draft({ id: "l", name: "Logs", dataSource: "logs" }),
					],
				}),
				...WINDOW,
			})

			assert.deepStrictEqual(result.rows, [{ name: "api", Traces: 9, Logs: 5 }])
		}),
	)

	/**
	 * The asymmetry with the timeseries path: here a failing query never escapes,
	 * so one broken query cannot blank a chart that has a working one.
	 */
	it.effect("folds every per-query failure, including the first, into a status", () =>
		Effect.gen(function* () {
			const { executor } = makeExecutor((request) =>
				request.query.kind === "breakdown" && request.query.source === "logs"
					? fail("logs are down")
					: breakdown([{ name: "api", value: 9 }]),
			)

			const result = yield* runBreakdownQuerySet(executor, {
				querySet: set({
					queries: [draft({ id: "l", dataSource: "logs" }), draft({ id: "t" })],
				}),
				...WINDOW,
			})

			assert.strictEqual(result.diagnostics[0].status, "error")
			assert.strictEqual(result.diagnostics[1].status, "success")
			// One survivor, so it keeps the narrow single-query shape.
			assert.deepStrictEqual(result.rows, [{ name: "api", value: 9 }])
		}),
	)

	it.effect("does not run hidden queries — nothing here consumes them", () =>
		Effect.gen(function* () {
			const { executor, requests } = makeExecutor(() => breakdown([{ name: "api", value: 1 }]))

			yield* runBreakdownQuerySet(executor, {
				querySet: set({ queries: [draft({ id: "a" }), draft({ id: "b", hidden: true })] }),
				...WINDOW,
			})

			assert.strictEqual(requests.length, 1)
		}),
	)

	it.effect("fails with QuerySetNoDataError when nothing came back", () =>
		Effect.gen(function* () {
			const { executor } = makeExecutor(() => breakdown([]))
			const outcome = yield* Effect.result(
				runBreakdownQuerySet(executor, { querySet: set(), ...WINDOW }),
			)

			assert.isTrue(outcome._tag === "Failure")
			if (outcome._tag !== "Failure") return
			assert.isTrue(outcome.failure instanceof QuerySetNoDataError)
		}),
	)

	it.effect("passes defaultLimit through so an 'Other' bucket is a real sum", () =>
		Effect.gen(function* () {
			const { executor, requests } = makeExecutor(() => breakdown([{ name: "api", value: 1 }]))

			yield* runBreakdownQuerySet(executor, { querySet: set(), ...WINDOW, defaultLimit: 50 })

			const query = requests[0].query
			assert.isTrue(query.kind === "breakdown")
			if (query.kind !== "breakdown") return
			assert.strictEqual(query.limit, 50)
		}),
	)
})

describe("runListQuerySet", () => {
	it.effect("returns the rows of the first enabled query", () =>
		Effect.gen(function* () {
			const { executor, requests } = makeExecutor(() => list([{ TraceId: "abc" }]))

			const result = yield* runListQuerySet(executor, {
				querySet: set({
					queries: [draft({ id: "off", enabled: false }), draft({ id: "on" })],
				}),
				...WINDOW,
			})

			// The disabled query is skipped, not merged.
			assert.strictEqual(requests.length, 1)
			assert.deepStrictEqual(result.rows, [{ TraceId: "abc" }])
		}),
	)

	it.effect("forwards limit to the lowering", () =>
		Effect.gen(function* () {
			const { executor, requests } = makeExecutor(() => list([]))

			yield* runListQuerySet(executor, {
				querySet: set(),
				...WINDOW,
				limit: 25,
				columns: ["TraceId", "Duration"],
			})

			const query = requests[0].query
			assert.isTrue(query.kind === "list")
			if (query.kind !== "list") return
			assert.strictEqual(query.limit, 25)
			// `columns` is not asserted here: `buildListQuerySpec` attaches it through
			// an `as QuerySpec` cast to a spec type that does not declare the field,
			// so there is nothing type-safe to read it back through. That hole is the
			// lowering's, not this runner's.
		}),
	)

	it.effect("fails when nothing is enabled", () =>
		Effect.gen(function* () {
			const { executor } = makeExecutor(() => list([]))
			const outcome = yield* Effect.result(
				runListQuerySet(executor, {
					querySet: set({ queries: [draft({ enabled: false })] }),
					...WINDOW,
				}),
			)

			assert.isTrue(outcome._tag === "Failure")
			if (outcome._tag !== "Failure") return
			assert.isTrue(outcome.failure instanceof QuerySetInputError)
		}),
	)

	/**
	 * Unlike breakdown, a wrong result kind fails outright here: there is only one
	 * query, so no sibling's data is lost by failing.
	 */
	it.effect("fails on an unexpected result kind", () =>
		Effect.gen(function* () {
			const { executor } = makeExecutor(() => breakdown([]))
			const outcome = yield* Effect.result(runListQuerySet(executor, { querySet: set(), ...WINDOW }))

			assert.isTrue(outcome._tag === "Failure")
			if (outcome._tag !== "Failure") return
			assert.include(outcome.failure.message, "Unexpected result kind")
		}),
	)
})

describe("runQuerySet", () => {
	it.effect("dispatches each shape to its runner and tags the output", () =>
		Effect.gen(function* () {
			const { executor } = makeExecutor((request) => {
				if (request.query.kind === "breakdown") return breakdown([{ name: "api", value: 1 }])
				if (request.query.kind === "list") return list([{ TraceId: "abc" }])
				return timeseries([{ bucket: "2026-01-02T00:00:00.000Z", series: { all: 2 } }])
			})

			const ts = yield* runQuerySet(executor, {
				querySet: set(),
				resultShape: "timeseries",
				...WINDOW,
			})
			const bd = yield* runQuerySet(executor, {
				querySet: set(),
				resultShape: "breakdown",
				...WINDOW,
			})
			const ls = yield* runQuerySet(executor, { querySet: set(), resultShape: "list", ...WINDOW })

			assert.strictEqual(ts.shape, "timeseries")
			assert.strictEqual(bd.shape, "breakdown")
			assert.strictEqual(ls.shape, "list")
			if (ls.shape !== "list") return
			assert.deepStrictEqual(ls.rows, [{ TraceId: "abc" }])
		}),
	)
})
