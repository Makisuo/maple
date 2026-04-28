import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { findSlowTraces } from "./find-slow-traces"
import { TinybirdExecutor, ObservabilityError } from "./TinybirdExecutor"
import type { TinybirdExecutorShape } from "./TinybirdExecutor"

interface CapturedCalls {
	sqlQueries: string[]
	pipeCalls: Array<{ pipe: string; params: Record<string, unknown> }>
}

const makeMockExecutor = (
	captured: CapturedCalls,
	sqlRows: ReadonlyArray<Record<string, unknown>> = [],
	pipeData: ReadonlyArray<Record<string, unknown>> = [],
): TinybirdExecutorShape =>
	({
		orgId: "org_test",
		sqlQuery: <T>(sql: string) => {
			captured.sqlQueries.push(sql)
			return Effect.succeed(sqlRows as ReadonlyArray<T>)
		},
		query: <T>(pipe: string, params: Record<string, unknown>) => {
			captured.pipeCalls.push({ pipe, params })
			return Effect.succeed({ data: pipeData as ReadonlyArray<T> })
		},
	}) as unknown as TinybirdExecutorShape

const makeLayer = (executor: TinybirdExecutorShape) => Layer.succeed(TinybirdExecutor, executor as any)

describe("findSlowTraces", () => {
	it("issues ORDER BY Duration DESC at the DB (not in JS) with the requested limit", async () => {
		const captured: CapturedCalls = { sqlQueries: [], pipeCalls: [] }
		const executor = makeMockExecutor(captured)

		await Effect.runPromise(
			findSlowTraces({
				timeRange: { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" },
				limit: 25,
			}).pipe(Effect.provide(makeLayer(executor))),
		)

		expect(captured.sqlQueries.length).toBe(1)
		const sql = captured.sqlQueries[0]!
		expect(sql).toMatch(/ORDER BY Duration DESC/)
		expect(sql).toMatch(/LIMIT 25/)
		expect(sql).toContain("ParentSpanId = ''")
		expect(sql).toContain("OrgId = 'org_test'")
		// Confirm we are NOT calling the list_traces pipe (old behavior)
		expect(captured.pipeCalls.find((c) => c.pipe === "list_traces")).toBeUndefined()
		// Stats pipe is still called
		expect(captured.pipeCalls.some((c) => c.pipe === "traces_duration_stats")).toBe(true)
	})

	it("adds service and environment filters when provided", async () => {
		const captured: CapturedCalls = { sqlQueries: [], pipeCalls: [] }
		const executor = makeMockExecutor(captured)

		await Effect.runPromise(
			findSlowTraces({
				timeRange: { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" },
				service: "api",
				environment: "production",
			}).pipe(Effect.provide(makeLayer(executor))),
		)

		const sql = captured.sqlQueries[0]!
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("ResourceAttributes['deployment.environment'] = 'production'")
	})

	it("defaults limit to 10 when not supplied", async () => {
		const captured: CapturedCalls = { sqlQueries: [], pipeCalls: [] }
		const executor = makeMockExecutor(captured)

		await Effect.runPromise(
			findSlowTraces({
				timeRange: { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" },
			}).pipe(Effect.provide(makeLayer(executor))),
		)

		expect(captured.sqlQueries[0]).toMatch(/LIMIT 10/)
	})
})
