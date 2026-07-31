import { describe, expect, it } from "vitest"
import { compileLocalLogServicesQuery } from "./use-local-log-services"

describe("compileLocalLogServicesQuery", () => {
	it("builds the Logs service filter from log-producing services", () => {
		const { sql } = compileLocalLogServicesQuery("2026-07-30 00:00:00", "2026-07-30 23:59:59")

		expect(sql).toContain("FROM logs_aggregates_hourly")
		expect(sql).toContain("ServiceName AS serviceName")
		expect(sql).toContain("GROUP BY serviceName")
		expect(sql).toContain("'service' AS facetType")
		expect(sql).not.toContain("UNION ALL")
		expect(sql).not.toContain("service_overview")
	})
})
