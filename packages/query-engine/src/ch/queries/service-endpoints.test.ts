import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/clickhouse-builder"
import { serviceOperationsSummaryQuery } from "./service-operations"
import {
	serviceEndpointsSummaryQuery,
	serviceEndpointsSummaryRawQuery,
	splitEndpointName,
} from "./service-endpoints"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

const HTTP_FILTER = "match(SpanName, '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ')"

describe("serviceEndpointsSummaryQuery", () => {
	it("filters every splice branch to HTTP endpoint names", () => {
		const { sql } = compileUnsafe(serviceEndpointsSummaryQuery({ serviceName: "api" }), baseParams)
		// Three branches: the raw edge matches on the computed display name, the
		// two rollup tiers on the name they already store normalized.
		expect(sql.split(HTTP_FILTER).length - 1).toBe(2)
		expect(sql).toContain("match(if(((SpanName LIKE 'http.server %'")
	})

	it("leaves the unfiltered Operations query untouched", () => {
		const { sql } = compileUnsafe(serviceOperationsSummaryQuery({ serviceName: "api" }), baseParams)
		expect(sql).not.toContain("match(SpanName, '^(GET|")
	})

	it("reports p50/p95/p99 out of two-level stored t-digest state", () => {
		const { sql } = compileUnsafe(serviceEndpointsSummaryQuery({ serviceName: "api" }), baseParams)
		expect(sql).toContain("quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles)")
		expect(sql).toContain("AS p99DurationMs")
	})

	it("scopes to the org on every branch", () => {
		const { sql } = compileUnsafe(
			serviceEndpointsSummaryQuery({ serviceName: "api", environments: ["production"] }),
			baseParams,
		)
		expect(sql.split("OrgId = 'org_1'").length - 1).toBe(3)
	})

	it("keeps the all-raw rollback path HTTP-filtered too", () => {
		const { sql } = compileUnsafe(serviceEndpointsSummaryRawQuery({ serviceName: "api" }), baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("service_operations_minutely")
		expect(sql).toContain("match(if(((SpanName LIKE 'http.server %'")
		expect(sql).toContain("quantile(0.99)(Duration)")
	})
})

describe("splitEndpointName", () => {
	it("splits a normalized endpoint name", () => {
		expect(splitEndpointName("GET /api/users/{id}")).toEqual({
			method: "GET",
			route: "/api/users/{id}",
		})
	})

	it("keeps the rest of the name when a route contains spaces", () => {
		expect(splitEndpointName("POST /a b")).toEqual({ method: "POST", route: "/a b" })
	})

	it("falls back to a route-only name rather than throwing", () => {
		expect(splitEndpointName("internal-work")).toEqual({ method: "", route: "internal-work" })
		expect(splitEndpointName("")).toEqual({ method: "", route: "" })
	})
})
