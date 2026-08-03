import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { WarehouseUpstreamError } from "@maple/domain/http"
import { getSessionTraces } from "./session-replays"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { WarehouseExecutorShape } from "./WarehouseExecutor"

interface Captured {
	sqls: string[]
}

interface MockResponses {
	detail?: ReadonlyArray<Record<string, unknown>>
	activity?: ReadonlyArray<Record<string, unknown>>
	summaries?: ReadonlyArray<Record<string, unknown>>
}

/**
 * Mock executor that records each SQL string and dispatches rows by which query
 * is running, matched on its source table. This stays correct regardless of the
 * execution order of the concurrent detail (`session_replays`) and activity
 * (`session_events`) reads; the trace summaries read `trace_detail_spans`.
 */
const makeExecutor = (captured: Captured, responses: MockResponses): WarehouseExecutorShape => {
	const rowsFor = (sql: string): ReadonlyArray<Record<string, unknown>> => {
		if (sql.includes("session_events")) return responses.activity ?? []
		if (sql.includes("trace_detail_spans")) return responses.summaries ?? []
		return responses.detail ?? []
	}
	return {
		orgId: "org_test",
		query: () => Effect.succeed({ data: [] as ReadonlyArray<never> }),
		compiledQuery: ((compiled) => {
			captured.sqls.push(compiled.sql)
			return compiled.decodeRows(rowsFor(compiled.sql)).pipe(Effect.orDie)
		}) as WarehouseExecutorShape["compiledQuery"],
		compiledQueryFirst: ((compiled) => {
			captured.sqls.push(compiled.sql)
			return compiled.decodeFirstRow(rowsFor(compiled.sql)).pipe(Effect.orDie)
		}) as WarehouseExecutorShape["compiledQueryFirst"],
	}
}

const makeLayer = (executor: WarehouseExecutorShape) => Layer.succeed(WarehouseExecutor, executor)

const traceIds = (n: number) => Array.from({ length: n }, (_, i) => `trace-${i}`)

/** The recorded SQL for the query that reads `table`, if it ran. */
const sqlFor = (captured: Captured, table: string) => captured.sqls.find((s) => s.includes(table))

describe("getSessionTraces", () => {
	it.effect("returns null and runs no summaries query when the session is missing", () =>
		Effect.gen(function* () {
			const captured: Captured = { sqls: [] }
			const out = yield* getSessionTraces({ sessionId: "missing" }).pipe(
				Effect.provide(makeLayer(makeExecutor(captured, { detail: [] }))),
			)

			assert.isNull(out.session)
			assert.deepStrictEqual(out.traces, [])
			assert.strictEqual(out.totalTraceCount, 0)
			// Detail + activity run concurrently; the summaries query never does.
			assert.isUndefined(sqlFor(captured, "trace_detail_spans"))
		}),
	)

	it.effect("skips the summaries query when the session has no correlated traces", () =>
		Effect.gen(function* () {
			const captured: Captured = { sqls: [] }
			const out = yield* getSessionTraces({ sessionId: "s1" }).pipe(
				Effect.provide(
					makeLayer(makeExecutor(captured, { detail: [{ sessionId: "s1", traceIds: [] }] })),
				),
			)

			assert.isNotNull(out.session)
			assert.deepStrictEqual(out.traces, [])
			assert.strictEqual(out.totalTraceCount, 0)
			// `TraceId IN ()` is never compiled.
			assert.isUndefined(sqlFor(captured, "trace_detail_spans"))
		}),
	)

	it.effect("merges the active/idle breakdown into the session metadata", () =>
		Effect.gen(function* () {
			const captured: Captured = { sqls: [] }
			const out = yield* getSessionTraces({ sessionId: "s1" }).pipe(
				Effect.provide(
					makeLayer(
						makeExecutor(captured, {
							detail: [{ sessionId: "s1", traceIds: [] }],
							activity: [{ sessionId: "s1", activeTimeMs: 21500, idleTimeMs: 8500 }],
						}),
					),
				),
			)

			assert.isNotNull(out.session)
			assert.strictEqual(out.session?.activeTimeMs, 21500)
			assert.strictEqual(out.session?.idleTimeMs, 8500)
		}),
	)

	it.effect("clamps the IN-list to the default of 50 trace ids", () =>
		Effect.gen(function* () {
			const captured: Captured = { sqls: [] }
			const out = yield* getSessionTraces({ sessionId: "s1" }).pipe(
				Effect.provide(
					makeLayer(
						makeExecutor(captured, { detail: [{ sessionId: "s1", traceIds: traceIds(150) }] }),
					),
				),
			)

			assert.strictEqual(out.totalTraceCount, 150)
			const summarySql = sqlFor(captured, "trace_detail_spans")!
			assert.include(summarySql, "trace-49")
			assert.notInclude(summarySql, "trace-50")
		}),
	)

	it.effect("caps an oversized explicit limit at 100", () =>
		Effect.gen(function* () {
			const captured: Captured = { sqls: [] }
			yield* getSessionTraces({ sessionId: "s1", limit: 999 }).pipe(
				Effect.provide(
					makeLayer(
						makeExecutor(captured, { detail: [{ sessionId: "s1", traceIds: traceIds(150) }] }),
					),
				),
			)

			const summarySql = sqlFor(captured, "trace_detail_spans")!
			assert.include(summarySql, "trace-99")
			assert.notInclude(summarySql, "trace-100")
		}),
	)

	it.effect("propagates warehouse errors from the executor", () =>
		Effect.gen(function* () {
			const failing: WarehouseExecutorShape = {
				orgId: "org_test",
				query: () => Effect.succeed({ data: [] }),
				compiledQuery: () =>
					Effect.fail(
						new WarehouseUpstreamError({
							pipeName: "session_traces",
							message: "ClickHouse exploded",
							upstreamStatus: 503,
						}),
					),
				compiledQueryFirst: () =>
					Effect.fail(
						new WarehouseUpstreamError({
							pipeName: "session_traces",
							message: "ClickHouse exploded",
							upstreamStatus: 503,
						}),
					),
			}

			const error = yield* getSessionTraces({ sessionId: "s1" }).pipe(
				Effect.provide(makeLayer(failing)),
				Effect.flip,
			)

			assert.instanceOf(error, WarehouseUpstreamError)
			assert.strictEqual(error.message, "ClickHouse exploded")
		}),
	)
})
