import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileCH } from "@maple-dev/clickhouse-builder"
import { planetscaleInfraTimeseriesRowSchema, planetscaleInfraTimeseriesSQL } from "./planetscale-infra"

describe("planetscaleInfraTimeseriesSQL", () => {
	it("buckets per-timestamp totals for one database", () => {
		const { sql } = compileCH(planetscaleInfraTimeseriesSQL(), {
			orgId: "org_1",
			startTime: "2026-07-02 00:00:00.000",
			endTime: "2026-07-03 00:00:00.000",
			bucketSeconds: 300,
			database: "main-db",
		})
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain(
			"coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) = 'main-db'",
		)
		// Inner per-timestamp grouping, outer bucketed aggregation.
		expect(sql).toContain("GROUP BY t")
		expect(sql).toContain("toStartOfInterval")
		expect(sql).toContain("GROUP BY bucket")
		expect(sql).toContain("avg(totalConnections)")
		expect(sql).toContain("max(cpuMax)")
		expect(sql).toContain("ORDER BY bucket ASC")
		expect(sql).toContain("FORMAT JSON")
	})

	it("decodes ClickHouse numeric strings through the row schema", () => {
		const compiled = compileCH(
			planetscaleInfraTimeseriesSQL(),
			{
				orgId: "org_1",
				startTime: "2026-07-02 00:00:00.000",
				endTime: "2026-07-03 00:00:00.000",
				bucketSeconds: 300,
				database: "main-db",
			},
			{ rowSchema: planetscaleInfraTimeseriesRowSchema },
		)
		expect(
			Effect.runSync(
				compiled.decodeRows([
					{
						bucket: "2026-07-02 00:00:00.000",
						connectionsAvg: "12.5",
						cpuMaxPercent: "80",
						memMaxPercent: "70.25",
						replicaLagMaxSeconds: "2",
					},
				]),
			),
		).toEqual([
			{
				bucket: "2026-07-02 00:00:00.000",
				connectionsAvg: 12.5,
				cpuMaxPercent: 80,
				memMaxPercent: 70.25,
				replicaLagMaxSeconds: 2,
			},
		])
	})
})
