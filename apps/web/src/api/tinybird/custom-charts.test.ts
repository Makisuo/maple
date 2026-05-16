import { beforeEach, describe, expect, it, vi } from "vitest"
import { Effect } from "effect"

const executeQueryEngineMock = vi.fn()

vi.mock("@/api/tinybird/effect-utils", async () => {
	const actual = await vi.importActual<typeof import("@/api/tinybird/effect-utils")>(
		"@/api/tinybird/effect-utils",
	)
	return {
		...actual,
		executeQueryEngine: (...args: unknown[]) => executeQueryEngineMock(...args),
	}
})

import { getOverviewTimeSeries } from "@/api/tinybird/custom-charts"

describe("querySpanMetricsCalls", () => {
	beforeEach(() => {
		executeQueryEngineMock.mockReset()
		executeQueryEngineMock.mockImplementation(() =>
			Effect.succeed({ result: { kind: "timeseries", data: [] } }),
		)
	})

	it("queries the monotonic SpanMetrics `calls` counter as a per-bucket increase, not raw sum", async () => {
		await Effect.runPromise(
			getOverviewTimeSeries({
				data: {
					startTime: "2026-02-01 00:00:00",
					endTime: "2026-02-01 01:00:00",
				},
			}),
		)

		const spanMetricsCalls = executeQueryEngineMock.mock.calls.filter(
			(call) => call[0] === "queryEngine.spanMetricsCalls",
		)

		expect(spanMetricsCalls.length).toBeGreaterThan(0)
		for (const [, request] of spanMetricsCalls) {
			expect(request.query.metric).toBe("increase")
		}
	})
})
