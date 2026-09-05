import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { errorDetail } from "./error-detail"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { WarehouseExecutorApi } from "./WarehouseExecutor"
import { compiledQueryOf } from "../execution/compiled-input"

interface CapturedCalls {
	pipeCalls: Array<{ pipe: string; params: Record<string, unknown> }>
}

const traceRow = (traceId: string, startTime: string) => ({
	traceId,
	startTime,
	durationMicros: 1000,
	spanCount: 3,
	services: ["api"],
	rootSpanName: "GET /",
	errorMessage: "boom",
	errorSpanId: "span-err",
	errorSpanName: "chat gpt-x",
	errorServiceName: "api",
	errorModel: "gpt-x",
	errorToolName: "",
	errorHttpMethod: "",
	errorHttpRoute: "",
	errorQueryContext: "",
	errorType: "",
})

const makeMockExecutor = (
	captured: CapturedCalls,
	tracesData: ReadonlyArray<unknown>,
): WarehouseExecutorApi => ({
	orgId: "org_test",
	compiledQuery: (compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: (compiled) => compiledQueryOf(compiled).decodeFirstRow([]).pipe(Effect.orDie),
	query: (pipe: string, params: Record<string, unknown>) => {
		captured.pipeCalls.push({ pipe, params })
		return Effect.succeed({
			data: (pipe === "error_detail_traces" ? tracesData : []) as ReadonlyArray<never>,
		})
	},
})

const makeLayer = (executor: WarehouseExecutorApi) => Layer.succeed(WarehouseExecutor, executor)

const timeRange = { startTime: "2026-04-01 00:00:00", endTime: "2026-04-08 00:00:00" }

describe("errorDetail", () => {
	it.effect("bounds each per-trace list_logs call to ±1h around the trace start", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }

			yield* errorDetail({
				fingerprintHash: "123",
				timeRange,
			}).pipe(
				Effect.provide(
					makeLayer(makeMockExecutor(captured, [traceRow("t1", "2026-04-03 12:00:00.123")])),
				),
			)

			const logs = captured.pipeCalls.filter((c) => c.pipe === "list_logs")
			assert.lengthOf(logs, 1)
			// Without an explicit range, pipe-dispatch falls back to an all-time
			// sentinel window (2023→2099) and the lookup scans full retention.
			assert.strictEqual(logs[0]!.params.start_time, "2026-04-03 11:00:00")
			assert.strictEqual(logs[0]!.params.end_time, "2026-04-03 13:00:00")
		}),
	)

	it.effect("falls back to the input time range when the trace start is unparseable", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }

			yield* errorDetail({
				fingerprintHash: "123",
				timeRange,
			}).pipe(Effect.provide(makeLayer(makeMockExecutor(captured, [traceRow("t1", "not-a-date")]))))

			const logs = captured.pipeCalls.filter((c) => c.pipe === "list_logs")
			assert.lengthOf(logs, 1)
			assert.strictEqual(logs[0]!.params.start_time, timeRange.startTime)
			assert.strictEqual(logs[0]!.params.end_time, timeRange.endTime)
		}),
	)

	it.effect("surfaces the failing span with only the attributes it carries", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }
			const result = yield* errorDetail({ fingerprintHash: "123", timeRange }).pipe(
				Effect.provide(
					makeLayer(makeMockExecutor(captured, [traceRow("t1", "2026-04-03 12:00:00")])),
				),
			)
			const span = result.traces[0]!.errorSpan
			assert.isDefined(span)
			assert.strictEqual(span!.name, "chat gpt-x")
			assert.strictEqual(span!.statusMessage, "boom")
			assert.deepStrictEqual(span!.attributes, { "gen_ai.request.model": "gpt-x" })
		}),
	)
})
