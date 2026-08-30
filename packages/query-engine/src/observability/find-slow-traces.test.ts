import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { WarehouseUpstreamError } from "@maple/domain/http"
import { findSlowTraces } from "./find-slow-traces"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { WarehouseExecutorApi } from "./WarehouseExecutor"
import { compiledQueryOf } from "../execution/compiled-input"

interface CapturedCalls {
	pipeCalls: Array<{ pipe: string; params: Record<string, unknown> }>
}

const makeMockExecutor = (
	captured: CapturedCalls,
	slowRows: ReadonlyArray<Record<string, unknown>> = [],
	statsRows: ReadonlyArray<Record<string, unknown>> = [],
): WarehouseExecutorApi => ({
	orgId: "org_test",
	compiledQuery: (compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: (compiled) => compiledQueryOf(compiled).decodeFirstRow([]).pipe(Effect.orDie),
	query: (pipe: string, params: Record<string, unknown>) => {
		captured.pipeCalls.push({ pipe, params })
		const data = pipe === "slow_traces" ? slowRows : pipe === "traces_duration_stats" ? statsRows : []
		return Effect.succeed({ data: data as ReadonlyArray<never> })
	},
})

const makeLayer = (executor: WarehouseExecutorApi) => Layer.succeed(WarehouseExecutor, executor)

describe("findSlowTraces", () => {
	it.effect("queries the slow_traces pipe (not list_traces) with the requested limit", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }

			yield* findSlowTraces({
				timeRange: { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" },
				limit: 25,
			}).pipe(Effect.provide(makeLayer(makeMockExecutor(captured))))

			const slow = captured.pipeCalls.find((c) => c.pipe === "slow_traces")
			assert.isDefined(slow)
			assert.strictEqual(slow!.params.limit, 25)
			assert.strictEqual(slow!.params.start_time, "2026-04-01 00:00:00")
			assert.strictEqual(slow!.params.end_time, "2026-04-02 00:00:00")
			// Confirm we are NOT calling the list_traces pipe (old behavior)
			assert.isUndefined(captured.pipeCalls.find((c) => c.pipe === "list_traces"))
			// Stats pipe is still called
			assert.isTrue(captured.pipeCalls.some((c) => c.pipe === "traces_duration_stats"))
		}),
	)

	it.effect("adds service and environment params when provided", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }

			yield* findSlowTraces({
				timeRange: { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" },
				service: "api",
				environment: "production",
			}).pipe(Effect.provide(makeLayer(makeMockExecutor(captured))))

			const slow = captured.pipeCalls.find((c) => c.pipe === "slow_traces")!
			assert.strictEqual(slow.params.service, "api")
			assert.strictEqual(slow.params.deployment_env, "production")
		}),
	)

	it.effect("defaults limit to 10 when not supplied", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }

			yield* findSlowTraces({
				timeRange: { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" },
			}).pipe(Effect.provide(makeLayer(makeMockExecutor(captured))))

			const slow = captured.pipeCalls.find((c) => c.pipe === "slow_traces")!
			assert.strictEqual(slow.params.limit, 10)
		}),
	)

	it.effect("maps non-empty rows and stats into the FindSlowTracesOutput shape", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }
			const executor = makeMockExecutor(
				captured,
				[
					{
						traceId: "trace-abc",
						spanName: "GET /api/users",
						serviceName: "api",
						durationMs: 1234,
						statusCode: "Ok",
						timestamp: "2026-04-01 12:00:00",
					},
				],
				[
					{
						minDurationMs: 5,
						maxDurationMs: 2000,
						p50DurationMs: 100,
						p95DurationMs: 1500,
					},
				],
			)

			const output = yield* findSlowTraces({
				timeRange: { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" },
			}).pipe(Effect.provide(makeLayer(executor)))

			assert.strictEqual(output.traces.length, 1)
			const trace = output.traces[0]!
			assert.strictEqual(trace.traceId, "trace-abc")
			assert.strictEqual(trace.spanId, null)
			assert.strictEqual(trace.spanName, "GET /api/users")
			assert.strictEqual(trace.serviceName, "api")
			assert.strictEqual(trace.durationMs, 1234)
			assert.strictEqual(trace.statusCode, "Ok")

			assert.isNotNull(output.stats)
			assert.strictEqual(output.stats!.p50Ms, 100)
			assert.strictEqual(output.stats!.p95Ms, 1500)
			assert.strictEqual(output.stats!.minMs, 5)
			assert.strictEqual(output.stats!.maxMs, 2000)
		}),
	)

	it.effect("propagates warehouse errors from the executor", () =>
		Effect.gen(function* () {
			const failingExecutor: WarehouseExecutorApi = {
				orgId: "org_test",
				compiledQuery: (compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
				compiledQueryFirst: (compiled) =>
					compiledQueryOf(compiled).decodeFirstRow([]).pipe(Effect.orDie),
				query: () =>
					Effect.fail(
						new WarehouseUpstreamError({
							pipeName: "find_slow_traces",
							message: "ClickHouse exploded",
							upstreamStatus: 503,
						}),
					),
			}

			const error = yield* findSlowTraces({
				timeRange: { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" },
			}).pipe(Effect.provide(makeLayer(failingExecutor)), Effect.flip)

			assert.instanceOf(error, WarehouseUpstreamError)
			assert.strictEqual(error.message, "ClickHouse exploded")
		}),
	)
})
