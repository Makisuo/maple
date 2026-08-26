import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileUnsafe, compileUnionUnsafe, type CompiledQuery } from "@maple-dev/clickhouse-builder"
import {
	orgTelemetryPulseQuery,
	serviceLivenessQuery,
	serviceLivenessRowSchema,
	telemetryPulseRowSchema,
} from "./liveness"

const pulseParams = {
	orgId: "org_123",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-01 00:10:00",
}

const livenessParams = {
	orgId: "org_123",
	serviceName: "checkout",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-01 00:30:00",
}

const decodeRows = <T>(compiled: CompiledQuery<T>, rows: ReadonlyArray<Record<string, unknown>>) =>
	Effect.runSync(compiled.decodeRows(rows))

describe("serviceLivenessQuery", () => {
	it("scopes to one org and service over a bounded minute window", () => {
		const { sql } = compileUnsafe(serviceLivenessQuery(), livenessParams)

		expect(sql).toContain("FROM service_operations_minutely")
		expect(sql).toContain("OrgId = 'org_123'")
		expect(sql).toContain("ServiceName = 'checkout'")
		expect(sql).toContain("Minute >= '2024-01-01 00:00:00'")
		expect(sql).toContain("Minute <= '2024-01-01 00:30:00'")
	})

	it("selects exact and sampling-corrected counts side by side", () => {
		const { sql } = compileUnsafe(serviceLivenessQuery(), livenessParams)

		// The pair is the whole point: a raw collapse with a steady corrected
		// count is a sampling change, not a traffic change.
		expect(sql).toContain("sum(SpanCount) AS spanCount")
		expect(sql).toContain("sum(EstimatedSpanCount) AS estimatedSpanCount")
		expect(sql).toContain("sum(ErrorCount) AS errorCount")
		expect(sql).toContain("sum(EstimatedErrorCount) AS estimatedErrorCount")
		expect(sql).toContain("uniq(Minute) AS minutesWithData")
		expect(sql).toContain("toString(max(Minute)) AS lastSeen")
	})

	it("is a group-less single-row aggregate", () => {
		const { sql } = compileUnsafe(serviceLivenessQuery(), livenessParams)
		expect(sql).not.toContain("GROUP BY")
		expect(sql).toContain("FORMAT JSON")
	})

	it("omits the environment predicate unless asked to scope to one", () => {
		const unscoped = compileUnsafe(serviceLivenessQuery(), livenessParams).sql
		expect(unscoped).not.toContain("DeploymentEnv")

		const scoped = compileUnsafe(serviceLivenessQuery({ scopeToEnvironment: true }), {
			...livenessParams,
			deploymentEnv: "production",
		}).sql
		expect(scoped).toContain("DeploymentEnv = 'production'")
	})

	it("decodes BYO-ClickHouse string counts to numbers", () => {
		const compiled = compileUnsafe(serviceLivenessQuery(), livenessParams, {
			rowSchema: serviceLivenessRowSchema,
		})

		// BYO ClickHouse quotes 64-bit ints; managed Tinybird returns numbers.
		const [byo] = decodeRows(compiled, [
			{
				minutesWithData: "28",
				spanCount: "14203",
				estimatedSpanCount: "14203",
				errorCount: "0",
				estimatedErrorCount: "0",
				lastSeen: "2024-01-01 00:29:00",
			},
		])
		expect(byo?.spanCount).toBe(14203)
		expect(byo?.errorCount).toBe(0)

		const [managed] = decodeRows(compiled, [
			{
				minutesWithData: 28,
				spanCount: 14203,
				estimatedSpanCount: 14203,
				errorCount: 0,
				estimatedErrorCount: 0,
				lastSeen: "2024-01-01 00:29:00",
			},
		])
		expect(managed?.spanCount).toBe(14203)
	})
})

describe("orgTelemetryPulseQuery", () => {
	it("unions a span and a log probe", () => {
		const { sql } = compileUnionUnsafe(orgTelemetryPulseQuery(), pulseParams)

		// 2 branches → exactly 1 UNION ALL separator.
		expect((sql.match(/UNION ALL/g) || []).length).toBe(1)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM logs")
		expect(sql).toContain("'spans' AS signal")
		expect(sql).toContain("'logs' AS signal")
	})

	it("selects count and a stringified max timestamp per branch", () => {
		const { sql } = compileUnionUnsafe(orgTelemetryPulseQuery(), pulseParams)
		expect(sql).toContain("count() AS count")
		// Stringified so the DateTime (spans) / DateTime64 (logs) branches share a
		// column type across the UNION.
		expect(sql).toContain("toString(max(Timestamp)) AS lastSeen")
		expect(sql).toContain("FORMAT JSON")
	})

	it("scopes every branch by OrgId and the bounded window", () => {
		const { sql } = compileUnionUnsafe(orgTelemetryPulseQuery(), pulseParams)
		expect((sql.match(/OrgId = 'org_123'/g) || []).length).toBe(2)
		expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00'")
		expect(sql).toContain("Timestamp <= '2024-01-01 00:10:00'")
		// The log branch also carries TimestampTime, the logs partition/index key.
		expect(sql).toContain("TimestampTime >= '2024-01-01 00:00:00'")
		expect(sql).toContain("TimestampTime <= '2024-01-01 00:10:00'")
	})

	it("decodes BYO-ClickHouse string counts to numbers", () => {
		const compiled = compileUnionUnsafe(orgTelemetryPulseQuery(), pulseParams, {
			rowSchema: telemetryPulseRowSchema,
		})

		// BYO ClickHouse quotes 64-bit ints; managed Tinybird returns numbers.
		const rows = decodeRows(compiled, [
			{ signal: "spans", count: "0", lastSeen: "1970-01-01 00:00:00" },
			{ signal: "logs", count: 42, lastSeen: "2024-01-01 00:09:00" },
		])
		expect(rows.map((row) => row.count)).toEqual([0, 42])
	})

	// The explicit `telemetryPulseRowSchema` above is now a *narrowing* of what
	// the builder already derives from the SELECT, not the thing that makes
	// decoding happen at all: `count()` is a `UInt64`, so a quoted count coerces
	// with no row schema passed.
	it("coerces a quoted count with no row schema passed", () => {
		const compiled = compileUnionUnsafe(orgTelemetryPulseQuery(), pulseParams)
		expect(compiled.rowSchemaSource).toBe("derived")
		const [row] = decodeRows(compiled, [{ signal: "spans", count: "7", lastSeen: "2024-01-01 00:09:00" }])
		expect(row?.count).toBe(7)
	})
})
