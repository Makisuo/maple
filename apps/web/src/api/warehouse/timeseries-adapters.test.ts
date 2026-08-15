// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { strict as assert } from "node:assert"
import { beforeEach, expect, vi } from "vitest"

const executeQueryEngineMock = vi.fn()
const runWarehouseQueryMock = vi.fn()
const listMetricsMock = vi.fn()

vi.mock("@/api/warehouse/effect-utils", () => ({
	WarehouseDateTimeString: Schema.String,
	WarehouseQueryError: class extends Error {
		_tag = "WarehouseQueryError"
	},
	decodeInput: (_schema: unknown, data: unknown) => Effect.succeed(data),
	invalidWarehouseInput: () => Effect.fail("invalid"),
	executeQueryEngine: (...args: unknown[]) => executeQueryEngineMock(...args),
	runWarehouseQuery: (...args: unknown[]) => runWarehouseQueryMock(...args),
}))

vi.mock("@/api/warehouse/metrics", () => ({
	listMetrics: (...args: unknown[]) => listMetricsMock(...args),
}))

import {
	getCustomChartServiceDetail,
	getCustomChartServiceSparklines,
	getOverviewTimeSeries,
} from "@/api/warehouse/custom-charts"
import { getServiceApdexTimeSeries } from "@/api/warehouse/services"

function tsResponse(data: Array<{ bucket: string; series: Record<string, number> }>) {
	return Effect.succeed({ result: { kind: "timeseries", source: "traces", data } })
}

const emptyTs = () => tsResponse([])

describe("timeseries adapters", () => {
	beforeEach(() => {
		executeQueryEngineMock.mockReset()
		runWarehouseQueryMock.mockReset()
		listMetricsMock.mockReset()
		listMetricsMock.mockReturnValue(Effect.succeed({ data: [] }))
	})

	it.effect("fills overview/detail buckets without flattening existing points", () =>
		Effect.gen(function* () {
			const bucket = "2026-01-01T00:00:00.000Z"

			executeQueryEngineMock.mockImplementation((operation: string) => {
				if (operation.includes("spanMetricsCalls")) return emptyTs()
				if (operation.includes("allMetrics")) {
					return tsResponse([
						{
							bucket,
							series: {
								count: 10,
								error_rate: 2,
								p50_duration: 11,
								p95_duration: 20,
								p99_duration: 30,
								apdex: 0.92,
							},
						},
					])
				}
				return emptyTs()
			})

			const overview = yield* getOverviewTimeSeries({
				data: {
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-01 00:25:00",
				},
			})
			const detail = yield* getCustomChartServiceDetail({
				data: {
					serviceName: "checkout",
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-01 00:25:00",
				},
			})

			// 25-min window auto-buckets to 60s → 26 buckets (00:00 … 00:25).
			assert.strictEqual(overview.data.length, 26)
			assert.strictEqual(detail.data.length, 26)
			expect(overview.data[0]).toMatchObject({
				bucket: "2026-01-01T00:00:00.000Z",
				throughput: 10,
				errorRate: 2,
			})
			expect(overview.data[1]).toMatchObject({
				bucket: "2026-01-01T00:01:00.000Z",
				throughput: 0,
				errorRate: 0,
			})
			expect(detail.data[0]).toMatchObject({
				bucket: "2026-01-01T00:00:00.000Z",
				throughput: 10,
				p95LatencyMs: 20,
				apdexScore: 0.92,
				totalCount: 10,
			})
		}),
	)

	it.effect("fills service sparklines per service across the selected timeline", () =>
		Effect.gen(function* () {
			executeQueryEngineMock.mockImplementation((operation: string) => {
				if (operation.includes("spanMetricsCalls")) return emptyTs()
				if (operation.includes("sparklines.allMetrics")) {
					return tsResponse([
						{
							bucket: "2026-01-01T00:00:00.000Z",
							series: {
								"count::checkout": 3,
								"error_rate::checkout": 1,
							},
						},
						{
							bucket: "2026-01-01T00:10:00.000Z",
							series: {
								"count::checkout": 5,
								"error_rate::checkout": 0,
							},
						},
					])
				}
				return emptyTs()
			})

			const response = yield* getCustomChartServiceSparklines({
				data: {
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-01 00:10:00",
				},
			})

			// 10-min window auto-buckets to 60s → 11 buckets (00:00 … 00:10).
			assert.strictEqual(response.data.checkout.length, 11)
			expect(response.data.checkout[0]).toMatchObject({
				bucket: "2026-01-01T00:00:00.000Z",
				throughput: 3,
				errorRate: 1,
			})
			expect(response.data.checkout[1]).toMatchObject({
				bucket: "2026-01-01T00:01:00.000Z",
				throughput: 0,
				errorRate: 0,
			})
			expect(response.data.checkout[10]).toMatchObject({
				bucket: "2026-01-01T00:10:00.000Z",
				throughput: 5,
				errorRate: 0,
			})

			const operations = executeQueryEngineMock.mock.calls.map((call) => String(call[0]))
			expect(operations).toContain("queryEngine.sparklines.allMetrics")
			expect(operations).not.toContain("queryEngine.sparklines.count")
			expect(operations).not.toContain("queryEngine.sparklines.errorRate")
		}),
	)

	it.effect("fills service apdex buckets while preserving real values", () =>
		Effect.gen(function* () {
			runWarehouseQueryMock.mockReturnValue(
				Effect.succeed({
					data: [
						{
							bucket: "2026-01-01 00:00:00",
							apdexScore: 0.91,
							totalCount: 100,
						},
					],
				}),
			)

			const response = yield* getServiceApdexTimeSeries({
				data: {
					serviceName: "checkout",
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-01 00:25:00",
				},
			})

			// 25-min window auto-buckets to 60s → 26 buckets (00:00 … 00:25).
			assert.strictEqual(response.data.length, 26)
			expect(response.data[0]).toMatchObject({
				bucket: "2026-01-01T00:00:00.000Z",
				apdexScore: 0.91,
				totalCount: 100,
			})
			expect(response.data[25]).toMatchObject({
				bucket: "2026-01-01T00:25:00.000Z",
				apdexScore: 0,
				totalCount: 0,
			})
		}),
	)
})
