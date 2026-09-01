import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
	compileMetricRateTimeseriesQuery,
	compileMetricValueTimeseriesQuery,
} from "./use-local-metric-detail"

const params = {
	orgId: "org_local",
	startTime: "2026-07-30 13:05:00",
	endTime: "2026-07-30 14:05:00",
	bucketSeconds: 60,
	metricName: "http.server.duration",
}

describe("metric detail timeseries queries", () => {
	// The chart draws at most 60 series; without the top-N cap a
	// high-cardinality install fetches and pivots every service's series before
	// the render limit ever applies.
	it("caps the value timeseries to the chart's series budget in the query", () => {
		const { sql } = Effect.runSync(compileMetricValueTimeseriesQuery({ metricType: "gauge" }, params))
		expect(sql).toContain("WITH __series_base AS")
		expect(sql).toContain("LIMIT 60")
	})

	it("caps the rate timeseries the same way", () => {
		const { sql } = Effect.runSync(
			compileMetricRateTimeseriesQuery(
				{ metricName: "http.server.duration", bucketSeconds: 60 },
				params,
			),
		)
		expect(sql).toContain("WITH __series_base AS")
		expect(sql).toContain("LIMIT 60")
	})
})
