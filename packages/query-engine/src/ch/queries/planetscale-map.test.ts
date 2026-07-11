import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	planetscaleBranchConnectionsSQL,
	planetscaleBranchGaugesSQL,
	planetscaleConnectionsSQL,
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
		expect(sql).toContain("planetscale_database'] != ''")
		expect(sql).toContain("GROUP BY database")
		expect(sql).not.toContain("planetscale_branch")
		expect(sql).toContain("FORMAT JSON")
	})

	it("adds the branch grouping (and database filter) for the detail panel", () => {
		const { sql } = compileCH(planetscaleBranchGaugesSQL(), {
			...baseParams,
			database: "main-db",
		})
		expect(sql).toContain("planetscale_branch']")
		expect(sql).toContain("GROUP BY database, branch")
		expect(sql).toContain("planetscale_database'] = 'main-db'")
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
