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

		it("ranks each group once with a top-N window when seriesLimit is set on a group-by", () => {
			const q = tracesTimeseriesQuery({
				metric: "count",
				needsSampling: false,
				groupBy: ["service"],
				bucketSeconds: 3600,
				seriesLimit: 5,
			})
			const { sql } = compileUnsafe(q, baseParams)
			// One base scan, with a deterministic rank shared by every bucket in a group.
			expect(sql).not.toContain("WITH __series_base AS")
			expect(sql).toContain("AS __series_base")
			expect(sql).toContain("max(count) OVER (PARTITION BY groupName)")
			expect(sql).toContain("ORDER BY __series_peak DESC, groupName ASC")
			expect(sql).toContain("__series_rank <= 5")
			expect(sql).toContain("dense_rank() OVER (")
			expect(sql).toContain("FORMAT JSON")
			// Parameters in the nested query must resolve at the outer compile.
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

		it("ranks each group once with a top-N window when seriesLimit is set on a group-by", () => {
			const q = logsTimeseriesQuery({
				groupBy: ["service"],
				bucketSeconds: 3600,
				seriesLimit: 3,
			})
			const { sql } = compileUnsafe(q, baseParams)
			expect(sql).not.toContain("WITH __series_base AS")
			expect(sql).toContain("max(count) OVER (PARTITION BY groupName)")
			expect(sql).toContain("__series_rank <= 3")
			expect(sql).toContain("dense_rank() OVER (")
			expect(sql).not.toContain("__PARAM_")
		})
	})
})
