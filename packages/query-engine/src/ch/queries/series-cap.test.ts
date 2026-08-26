import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/clickhouse-builder"
import { tracesTimeseriesQuery } from "./traces"
import { logsTimeseriesQuery } from "./logs"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
	bucketSeconds: 3600,
}

describe("series cap (finalizeTimeseries)", () => {
	describe("traces", () => {
		it("does NOT wrap the query when seriesLimit is unset", () => {
			const q = tracesTimeseriesQuery({
				metric: "count",
				needsSampling: false,
				groupBy: ["service"],
				bucketSeconds: 3600,
			})
			const { sql } = compileUnsafe(q, baseParams)
			expect(sql).not.toContain("__series_base")
			expect(sql).toContain("FORMAT JSON")
		})

		it("does NOT wrap the query when there is no real group-by", () => {
			const q = tracesTimeseriesQuery({
				metric: "count",
				needsSampling: false,
				groupBy: ["none"],
				bucketSeconds: 3600,
				seriesLimit: 5,
			})
			const { sql } = compileUnsafe(q, baseParams)
			expect(sql).not.toContain("__series_base")
		})

		it("wraps the query in a top-N CTE when seriesLimit is set on a group-by", () => {
			const q = tracesTimeseriesQuery({
				metric: "count",
				needsSampling: false,
				groupBy: ["service"],
				bucketSeconds: 3600,
				seriesLimit: 5,
			})
			const { sql } = compileUnsafe(q, baseParams)
			// CTE wrapper + ranking + restriction to top-N group names.
			expect(sql).toContain("WITH __series_base AS")
			expect(sql).toContain("FROM __series_base")
			expect(sql).toContain("max(count) AS rank")
			expect(sql).toContain("ORDER BY rank DESC")
			expect(sql).toContain("LIMIT 5")
			expect(sql).toContain("groupName IN (")
			expect(sql).toContain("FORMAT JSON")
			// Params inside the CTE must be resolved by the outer compile.
			expect(sql).not.toContain("__PARAM_")
		})
	})

	describe("logs", () => {
		it("does NOT wrap the query when seriesLimit is unset", () => {
			const q = logsTimeseriesQuery({
				groupBy: ["service"],
				bucketSeconds: 3600,
			})
			const { sql } = compileUnsafe(q, baseParams)
			expect(sql).not.toContain("__series_base")
		})

		it("wraps the query in a top-N CTE when seriesLimit is set on a group-by", () => {
			const q = logsTimeseriesQuery({
				groupBy: ["service"],
				bucketSeconds: 3600,
				seriesLimit: 3,
			})
			const { sql } = compileUnsafe(q, baseParams)
			expect(sql).toContain("WITH __series_base AS")
			expect(sql).toContain("max(count) AS rank")
			expect(sql).toContain("LIMIT 3")
			expect(sql).toContain("groupName IN (")
			expect(sql).not.toContain("__PARAM_")
		})
	})
})
