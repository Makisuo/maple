import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { exploreAttributeKeys, exploreAttributeValues } from "./explore-attributes"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { WarehouseExecutorApi } from "./WarehouseExecutor"

interface CapturedCalls {
	pipeCalls: Array<{ pipe: string; params: Record<string, unknown> }>
}

const makeMockExecutor = (captured: CapturedCalls): WarehouseExecutorApi => ({
	orgId: "org_test",
	compiledQuery: (compiled) => compiled.decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: (compiled) => compiled.decodeFirstRow([]).pipe(Effect.orDie),
	query: (pipe: string, params: Record<string, unknown>) => {
		captured.pipeCalls.push({ pipe, params })
		return Effect.succeed({ data: [] as ReadonlyArray<never> })
	},
})

const makeLayer = (executor: WarehouseExecutorApi) => Layer.succeed(WarehouseExecutor, executor)

const timeRange = { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" }

describe("exploreAttributeValues", () => {
	it.effect("routes source=metrics to the metric_attribute_values pipe (not span)", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }

			yield* exploreAttributeValues({ source: "metrics", timeRange, key: "group" }).pipe(
				Effect.provide(makeLayer(makeMockExecutor(captured))),
			)

			const call = captured.pipeCalls[0]
			assert.isDefined(call)
			assert.strictEqual(call.pipe, "metric_attribute_values")
			assert.strictEqual(call.params.attribute_key, "group")
		}),
	)

	it.effect("routes traces+resource scope to resource_attribute_values", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }

			yield* exploreAttributeValues({
				source: "traces",
				scope: "resource",
				timeRange,
				key: "service.name",
			}).pipe(Effect.provide(makeLayer(makeMockExecutor(captured))))

			assert.strictEqual(captured.pipeCalls[0]?.pipe, "resource_attribute_values")
		}),
	)

	it.effect("defaults traces span scope to span_attribute_values", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }

			yield* exploreAttributeValues({ source: "traces", timeRange, key: "http.method" }).pipe(
				Effect.provide(makeLayer(makeMockExecutor(captured))),
			)

			assert.strictEqual(captured.pipeCalls[0]?.pipe, "span_attribute_values")
		}),
	)
})

describe("exploreAttributeKeys", () => {
	it.effect("routes source=metrics to the metric_attribute_keys pipe", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }

			yield* exploreAttributeKeys({ source: "metrics", timeRange }).pipe(
				Effect.provide(makeLayer(makeMockExecutor(captured))),
			)

			assert.strictEqual(captured.pipeCalls[0]?.pipe, "metric_attribute_keys")
		}),
	)
})
