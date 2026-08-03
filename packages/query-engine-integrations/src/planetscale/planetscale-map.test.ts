import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	planetscaleBranchConnectionsRowSchema,
	planetscaleBranchConnectionsSQL,
	planetscaleBranchStatsRowSchema,
	planetscaleBranchGaugesSQL,
	planetscaleConnectionsRowSchema,
	planetscaleConnectionsSQL,
	planetscaleDatabaseStatsRowSchema,
	planetscaleGaugesSQL,
} from "./planetscale-map"

const baseParams = {
	orgId: "org_1",
	startTime: "2026-07-02 00:00:00.000",
	endTime: "2026-07-03 00:00:00.000",
}

describe("planetscaleGaugesSQL", () => {
	it("rolls up CPU/memory/replica-lag maxima per database over metrics_gauge", () => {
		const { sql } = compileCH(planetscaleGaugesSQL(), baseParams)
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("maxIf(Value, MetricName IN ('planetscale_pods_cpu_util_percentages'))")
		expect(sql).toContain("maxIf(Value, MetricName IN ('planetscale_pods_mem_util_percentages'))")
		// Both products' replica-lag spellings are covered.
		expect(sql).toContain("planetscale_mysql_replica_lag_seconds")
		expect(sql).toContain("planetscale_postgres_replica_lag_seconds")
		// Rows without the discovery label can't be attributed to a database.
		expect(sql).toContain(
			"coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) != ''",
		)
		expect(sql).toContain("GROUP BY database")
		expect(sql).not.toContain("planetscale_branch_name")
		expect(sql).toContain("FORMAT JSON")
	})

	it("adds the branch grouping (and database filter) for the detail panel", () => {
		const { sql } = compileCH(planetscaleBranchGaugesSQL(), {
			...baseParams,
			database: "main-db",
		})
		expect(sql).toContain(
			"coalesce(nullIf(Attributes['planetscale_branch_name'], ''), Attributes['planetscale_branch'])",
		)
		expect(sql).toContain("GROUP BY database, branch")
		expect(sql).toContain(
			"coalesce(nullIf(Attributes['planetscale_database_name'], ''), Attributes['planetscale_database']) = 'main-db'",
		)
	})

	it("escapes single quotes in orgId", () => {
		const { sql } = compileCH(planetscaleGaugesSQL(), { ...baseParams, orgId: "org'evil" })
		expect(sql).toContain("OrgId = 'org\\'evil'")
	})
})

describe("planetscaleConnectionsSQL", () => {
	it("sums connection series per timestamp before averaging over the window", () => {
		const { sql } = compileCH(planetscaleConnectionsSQL(), baseParams)
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain("planetscale_edge_active_connections")
		expect(sql).toContain("planetscale_edge_postgres_active_connections")
		// Inner grouping by (database, timestamp), outer avg/max of the totals.
		expect(sql).toContain("GROUP BY database, t")
		expect(sql).toContain("avg(totalConnections)")
		expect(sql).toContain("max(totalConnections)")
		expect(sql).toContain("FORMAT JSON")
	})

	it("supports the per-branch breakdown", () => {
		const { sql } = compileCH(planetscaleBranchConnectionsSQL(), {
			...baseParams,
			database: "main-db",
		})
		expect(sql).toContain("GROUP BY database, branch, t")
		expect(sql).toContain("GROUP BY database, branch")
	})
})

describe("PlanetScale map row schemas", () => {
	it("decode ClickHouse numeric strings for database and branch outputs", () => {
		const databaseStats = compileCH(planetscaleGaugesSQL(), baseParams, {
			rowSchema: planetscaleDatabaseStatsRowSchema,
		})
		const branchStats = compileCH(
			planetscaleBranchGaugesSQL(),
			{ ...baseParams, database: "main-db" },
			{ rowSchema: planetscaleBranchStatsRowSchema },
		)
		const connections = compileCH(planetscaleConnectionsSQL(), baseParams, {
			rowSchema: planetscaleConnectionsRowSchema,
		})
		const branchConnections = compileCH(
			planetscaleBranchConnectionsSQL(),
			{ ...baseParams, database: "main-db" },
			{ rowSchema: planetscaleBranchConnectionsRowSchema },
		)

		expect(
			Effect.runSync(
				databaseStats.decodeRows([
					{
						database: "main-db",
						cpuMaxPercent: "90.5",
						memMaxPercent: "75",
						replicaLagMaxSeconds: "3",
					},
				]),
			),
		).toEqual([
			{
				database: "main-db",
				cpuMaxPercent: 90.5,
				memMaxPercent: 75,
				replicaLagMaxSeconds: 3,
			},
		])
		expect(
			Effect.runSync(
				branchStats.decodeRows([
					{
						database: "main-db",
						branch: "main",
						cpuMaxPercent: "85",
						memMaxPercent: "65",
						replicaLagMaxSeconds: "1.5",
					},
				]),
			),
		).toEqual([
			{
				database: "main-db",
				branch: "main",
				cpuMaxPercent: 85,
				memMaxPercent: 65,
				replicaLagMaxSeconds: 1.5,
			},
		])
		expect(
			Effect.runSync(
				connections.decodeRows([
					{ database: "main-db", connectionsAvg: "12.25", connectionsMax: "18" },
				]),
			),
		).toEqual([{ database: "main-db", connectionsAvg: 12.25, connectionsMax: 18 }])
		expect(
			Effect.runSync(
				branchConnections.decodeRows([
					{
						database: "main-db",
						branch: "main",
						connectionsAvg: "6.5",
						connectionsMax: "9",
					},
				]),
			),
		).toEqual([{ database: "main-db", branch: "main", connectionsAvg: 6.5, connectionsMax: 9 }])
	})
})
