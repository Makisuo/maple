import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { OrgId } from "@maple/domain/http"
import { searchLogs } from "./search-logs"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { WarehouseExecutorShape } from "./WarehouseExecutor"
import { compilePipeQuery } from "../ch/pipe-dispatch"

const asOrgId = Schema.decodeUnknownSync(OrgId)

interface CapturedCalls {
	pipeCalls: Array<{
		pipe: string
		params: Record<string, unknown>
		options?: { settings?: { maxBlockSize?: number } }
	}>
}

const makeMockExecutor = (captured: CapturedCalls): WarehouseExecutorShape => ({
	orgId: "org_test",
	compiledQuery: (compiled) => compiled.decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: (compiled) => compiled.decodeFirstRow([]).pipe(Effect.orDie),
	query: (
		pipe: string,
		params: Record<string, unknown>,
		options?: { settings?: { maxBlockSize?: number } },
	) => {
		captured.pipeCalls.push({ pipe, params, options })
		return Effect.succeed({ data: [] as ReadonlyArray<never> })
	},
})

const makeLayer = (executor: WarehouseExecutorShape) => Layer.succeed(WarehouseExecutor, executor)

const timeRange = { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" }

describe("searchLogs", () => {
	it.effect(
		"forwards `search` under the `search` key the dispatch reads (regression: was `body_search`)",
		() =>
			Effect.gen(function* () {
				const captured: CapturedCalls = { pipeCalls: [] }

				yield* searchLogs({ timeRange, search: "boom" }).pipe(
					Effect.provide(makeLayer(makeMockExecutor(captured))),
				)

				const list = captured.pipeCalls.find((c) => c.pipe === "list_logs")
				const count = captured.pipeCalls.find((c) => c.pipe === "logs_count")
				assert.isDefined(list)
				assert.isDefined(count)

				// The dispatch reads `str("search")`; emitting `body_search` would be
				// silently dropped. Assert the canonical key is present and the stale
				// key is absent on BOTH pipe calls.
				assert.strictEqual(list!.params.search, "boom")
				assert.isUndefined(list!.params.body_search)
				assert.strictEqual(count!.params.search, "boom")
				assert.isUndefined(count!.params.body_search)

				// Body search reads the wide Body column — both calls must carry the
				// block-size guardrail (see WarehouseQuerySettings.maxBlockSize).
				assert.strictEqual(list!.options?.settings?.maxBlockSize, 512)
				assert.strictEqual(count!.options?.settings?.maxBlockSize, 512)
			}),
	)

	it.effect("the forwarded params compile into a `Body ILIKE` filter on both pipes", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }

			yield* searchLogs({ timeRange, search: "boom" }).pipe(
				Effect.provide(makeLayer(makeMockExecutor(captured))),
			)

			// Feed the exact params searchLogs produced through the real dispatcher —
			// proves the free-text filter reaches the compiled SQL end-to-end.
			for (const pipe of ["list_logs", "logs_count"] as const) {
				const call = captured.pipeCalls.find((c) => c.pipe === pipe)!
				const compiled = compilePipeQuery(pipe, { ...call.params, org_id: asOrgId("org_test") })
				assert.isDefined(compiled)
				assert.include(compiled!.sql, "Body ILIKE '%boom%'")
			}
		}),
	)

	it.effect("omits the search filter entirely when no search term is given", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }

			yield* searchLogs({ timeRange }).pipe(Effect.provide(makeLayer(makeMockExecutor(captured))))

			for (const call of captured.pipeCalls) {
				assert.isUndefined(call.params.search)
				assert.isUndefined(call.params.body_search)
				assert.isUndefined(call.options?.settings)
				const compiled = compilePipeQuery(call.pipe, { ...call.params, org_id: asOrgId("org_test") })
				assert.notInclude(compiled!.sql, "Body ILIKE")
			}
		}),
	)
})
