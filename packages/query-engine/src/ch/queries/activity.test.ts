import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import { activeOrgsByErrorEventsQuery, activeOrgsByLogsQuery, activeOrgsByTracesQuery } from "./activity"

const params = { startTime: "2026-06-22 05:00:00" }

describe("active-org discovery queries", () => {
	it("error-events query is cross-org but contains the OrgId guard token", () => {
		const { sql } = compileCH(activeOrgsByErrorEventsQuery(), params)
		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("OrgId AS orgId")
		expect(sql).toContain("Timestamp >= '2026-06-22 05:00:00'")
		expect(sql).toContain("GROUP BY orgId")
		// Cross-org: must NOT pin to a single org.
		expect(sql).not.toContain("OrgId =")
		// Deliberately cross-org: the executor refuses these on the ordinary read
		// path, so they must go through `crossOrgQuery`.
		expect(sql).toContain("OrgId")
	})

	it("traces query scans the hourly MV by Hour", () => {
		const { sql } = compileCH(activeOrgsByTracesQuery(), params)
		expect(sql).toContain("FROM traces_aggregates_hourly")
		expect(sql).toContain("Hour >= '2026-06-22 05:00:00'")
		expect(sql).toContain("GROUP BY orgId")
		expect(sql).not.toContain("OrgId =")
	})

	it("logs query scans the hourly MV by Hour", () => {
		const { sql } = compileCH(activeOrgsByLogsQuery(), params)
		expect(sql).toContain("FROM logs_aggregates_hourly")
		expect(sql).toContain("Hour >= '2026-06-22 05:00:00'")
		expect(sql).toContain("GROUP BY orgId")
		expect(sql).not.toContain("OrgId =")
	})
})
