import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileUnsafe } from "@maple-dev/clickhouse-builder"
import {
	planetscaleBranchInfraTimeseriesSQL,
	planetscaleInfraTimeseriesRowSchema,
	planetscaleInfraTimeseriesSQL,
} from "./planetscale-infra"

describe("planetscaleInfraTimeseriesSQL", () => {
	it("buckets per-timestamp totals for one database", () => {
		const { sql } = compileUnsafe(planetscaleInfraTimeseriesSQL(), {
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
		const compiled = compileUnsafe(
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
						// Numerics arrive quoted on BYO-ClickHouse.
						storageUsedPercent: "66.9",
						storageSamples: "288",
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
				storageUsedPercent: 66.9,
				storageSamples: 288,
			},
		])
	})

	it("aggregates volume gauges without counting unsampled buckets as full", () => {
		const { sql } = compileUnsafe(planetscaleInfraTimeseriesSQL(), {
			orgId: "org_1",
			startTime: "2026-07-02 00:00:00.000",
			endTime: "2026-07-03 00:00:00.000",
			bucketSeconds: 300,
			database: "main-db",
		})
		expect(sql).toContain("planetscale_volume_capacity_bytes")
		expect(sql).toContain("planetscale_volume_available_bytes")
		// Free space is scraped less often than capacity; buckets with no free-space
		// sample must be excluded rather than read as zero bytes free.
		expect(sql).toContain("availableSamples > 0")
		// Phrased so SQL precedence yields a percentage — see planetscale-storage.test.ts.
		expect(sql).toContain("100 - availableBytes / capacityBytes * 100")
	})
})

describe("planetscaleBranchInfraTimeseriesSQL", () => {
	it("scopes the same rollup to a single branch", () => {
		const { sql } = compileUnsafe(planetscaleBranchInfraTimeseriesSQL(), {
			orgId: "org_1",
			startTime: "2026-07-02 00:00:00.000",
			endTime: "2026-07-03 00:00:00.000",
			bucketSeconds: 300,
			database: "main-db",
			branch: "pr-246",
		})
		expect(sql).toContain(
			"coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) = 'main-db'",
		)
		expect(sql).toContain(
			"coalesce(nullIf(Attributes['planetscale_branch_name'], ''), Attributes['planetscale_branch']) = 'pr-246'",
		)
		expect(sql).toContain("GROUP BY bucket")
		expect(sql).toContain("ORDER BY bucket ASC")
	})
})
