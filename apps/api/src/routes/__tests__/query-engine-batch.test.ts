import { assert, describe, it } from "@effect/vitest"
import type { QueryEngineResult } from "@maple/query-engine"
import { Effect, Schema } from "effect"
import { runQueryEngineBatch } from "@/routes/query-engine-batch"

class StubError extends Schema.TaggedError<StubError>()("@maple/http/errors/QueryEngineExecutionError", {
	message: Schema.String,
}) {}

const countResult = (total: number): QueryEngineResult => ({
	kind: "count",
	source: "logs",
	data: { total },
})

const totalOf = (outcome: { outcome: string; result?: QueryEngineResult }): number => {
	assert.strictEqual(outcome.outcome, "success")
	const result = outcome.result
	assert.ok(result !== undefined && result.kind === "count")
	return result.kind === "count" ? result.data.total : -1
}

describe("runQueryEngineBatch", () => {
	it.effect("returns one outcome per request, positionally aligned", () =>
		Effect.gen(function* () {
			const outcomes = yield* runQueryEngineBatch({
				requests: [10, 20, 30],
				execute: (n: number) => Effect.succeed(countResult(n)),
			})
			assert.strictEqual(outcomes.length, 3)
			assert.deepStrictEqual(outcomes.map(totalOf), [10, 20, 30])
		}),
	)

	it.effect("isolates a failing query from its siblings", () =>
		Effect.gen(function* () {
			const outcomes = yield* runQueryEngineBatch({
				requests: [1, 2, 3],
				execute: (n: number) =>
					n === 2
						? Effect.fail(new StubError({ message: "boom" }))
						: Effect.succeed(countResult(n)),
			})

			assert.deepStrictEqual(
				outcomes.map((o) => o.outcome),
				["success", "failure", "success"],
			)
			const failed = outcomes[1]
			assert.ok(failed !== undefined && failed.outcome === "failure")
			// The original tag rides along so the client keeps its specific copy.
			assert.strictEqual(failed.error._tag, "@maple/http/errors/QueryEngineExecutionError")
			assert.strictEqual(failed.error.message, "boom")
		}),
	)

	it.live("bounds total wall time with a deadline shared by every item", () =>
		Effect.gen(function* () {
			const started = Date.now()
			// 8 items at concurrency 2 = 4 waves. Each query would take 200ms, so
			// a per-item timeout would let this run ~800ms; the SHARED deadline has
			// to cut it off at ~120ms instead.
			const outcomes = yield* runQueryEngineBatch({
				requests: [1, 2, 3, 4, 5, 6, 7, 8],
				execute: (n: number) => Effect.succeed(countResult(n)).pipe(Effect.delay("200 millis")),
				deadlineMs: 120,
				concurrency: 2,
			})
			const elapsed = Date.now() - started

			assert.strictEqual(outcomes.length, 8)
			// Bound chosen to discriminate: a SHARED deadline finishes in ~120ms
			// (later waves find no budget left and return instantly), whereas a
			// per-item 120ms timeout would take 4 waves × 120ms ≈ 480ms.
			assert.ok(elapsed < 300, `batch ran ${elapsed}ms — the deadline is per-item, not shared`)
			// Everything timed out, and a timeout is a per-item failure, not a throw.
			assert.ok(outcomes.every((o) => o.outcome === "failure"))
			const first = outcomes[0]
			assert.ok(first !== undefined && first.outcome === "failure")
			assert.strictEqual(first.error._tag, "@maple/http/errors/QueryEngineTimeoutError")
		}),
	)

	it.live("still returns fast results when only some queries are slow", () =>
		Effect.gen(function* () {
			const outcomes = yield* runQueryEngineBatch({
				requests: [1, 2, 3],
				execute: (n: number) =>
					n === 2
						? Effect.succeed(countResult(n)).pipe(Effect.delay("5 seconds"))
						: Effect.succeed(countResult(n)),
				deadlineMs: 150,
				concurrency: 3,
			})

			assert.deepStrictEqual(
				outcomes.map((o) => o.outcome),
				["success", "failure", "success"],
			)
		}),
	)

	it.effect("handles an empty batch without calling execute", () =>
		Effect.gen(function* () {
			let calls = 0
			const outcomes = yield* runQueryEngineBatch({
				requests: [],
				execute: (n: number) => {
					calls += 1
					return Effect.succeed(countResult(n))
				},
			})
			assert.strictEqual(outcomes.length, 0)
			assert.strictEqual(calls, 0)
		}),
	)
})
