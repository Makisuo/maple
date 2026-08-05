import { describe, expect, it } from "vitest"
import { compileLocalLogServicesQuery } from "./use-local-log-services"

describe("compileLocalLogServicesQuery", () => {
	it("builds the Logs service filter from log-producing services", () => {
		const { sql } = compileLocalLogServicesQuery("2026-07-30 13:05:00", "2026-07-30 14:05:00")

		expect(sql).toContain("FROM logs")
		expect(sql).toContain("ServiceName AS name")
		expect(sql).toContain("TimestampTime >= '2026-07-30 13:05:00'")
		expect(sql).toContain("TimestampTime <= '2026-07-30 14:05:00'")
		expect(sql).toContain("Timestamp >= '2026-07-30 13:05:00'")
		expect(sql).toContain("Timestamp <= '2026-07-30 14:05:00'")
		expect(sql).toContain("GROUP BY name")
		expect(sql).not.toContain("LIMIT")
		expect(sql).not.toContain("UNION ALL")
		expect(sql).not.toContain("logs_aggregates_hourly")
	})

	it("cannot offer a stale service that exists only in the hourly aggregate", () => {
		const { sql } = compileLocalLogServicesQuery("2026-07-01 00:00:00", "2026-07-30 23:59:59")

		expect(sql).toContain("FROM logs")
		expect(sql).not.toContain("logs_aggregates_hourly")
	})
})
