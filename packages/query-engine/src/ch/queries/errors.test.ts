import { describe, expect, it } from "vitest"
import { compileCH, compileUnion } from "@maple-dev/clickhouse-builder"
import {
	errorsByTypeQuery,
	errorsTimeseriesQuery,
	errorsSummaryQuery,
	errorDetailTracesQuery,
	errorsFacetsQuery,
	errorIssuesQuery,
	errorFingerprintsQuery,
	tracesFacetsQuery,
} from "./errors"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
	bucketSeconds: 3600,
}

// ---------------------------------------------------------------------------
// errorsByTypeQuery
// ---------------------------------------------------------------------------

describe("errorsByTypeQuery", () => {
	it("compiles broad errors by type from the time-ordered error events table", () => {
		const q = errorsByTypeQuery({})
		const { sql } = compileCH(q, baseParams)
		// Broad recent-window scans prune on (OrgId, Timestamp, FingerprintHash).
		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("toString(FingerprintHash) AS fingerprintHash")
		expect(sql).toContain("any(ErrorLabel) AS errorLabel")
		expect(sql).toContain("count() AS count")
		expect(sql).toContain("uniq(ServiceName) AS affectedServicesCount")
		expect(sql).toContain("min(Timestamp) AS firstSeen")
		expect(sql).toContain("max(Timestamp) AS lastSeen")
		expect(sql).toContain("GROUP BY fingerprintHash")
		expect(sql).toContain("ORDER BY count DESC")
		expect(sql).toContain("LIMIT 50")
		expect(sql).toContain("FORMAT JSON")
	})

	it("applies rootOnly filter", () => {
		const q = errorsByTypeQuery({ rootOnly: true })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ParentSpanId = ''")
	})

	it("applies services filter", () => {
		const q = errorsByTypeQuery({ services: ["api", "web"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName IN ('api', 'web')")
	})

	it("applies deploymentEnvs filter", () => {
		const q = errorsByTypeQuery({ deploymentEnvs: ["production"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("DeploymentEnv IN ('production')")
	})

	it("filters by fingerprint hash (stable identity round-trip)", () => {
		const q = errorsByTypeQuery({ fingerprintHashes: ["12345678901234567890"] })
		const { sql } = compileCH(q, baseParams)
		// Fingerprint-constrained scans use the fingerprint-ordered table.
		expect(sql).toContain("FROM error_events")
		expect(sql).not.toContain("FROM error_events_by_time")
		expect(sql).toContain("FingerprintHash IN (toUInt64('12345678901234567890'))")
	})

	it("applies custom limit", () => {
		const q = errorsByTypeQuery({ limit: 25 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 25")
	})
})

// ---------------------------------------------------------------------------
// errorsTimeseriesQuery
// ---------------------------------------------------------------------------

describe("errorsTimeseriesQuery", () => {
	it("compiles error timeseries with bucket", () => {
		const q = errorsTimeseriesQuery({ fingerprintHash: "98765432109876543210" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM error_events")
		expect(sql).toContain("toStartOfInterval")
		expect(sql).toContain("INTERVAL 3600 SECOND")
		expect(sql).toContain("count() AS count")
		expect(sql).toContain("GROUP BY bucket")
		expect(sql).toContain("ORDER BY bucket ASC")
		// Fingerprint hash filter in WHERE
		expect(sql).toContain("FingerprintHash = toUInt64('98765432109876543210')")
	})

	it("applies services filter", () => {
		const q = errorsTimeseriesQuery({ fingerprintHash: "1", services: ["api"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName IN ('api')")
	})
})

// ---------------------------------------------------------------------------
// errorsSummaryQuery
// ---------------------------------------------------------------------------

describe("errorsSummaryQuery", () => {
	it("compiles CROSS JOIN between filtered totals", () => {
		const q = errorsSummaryQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("CROSS JOIN")
		expect(sql).toContain("FROM (SELECT")
		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("e.totalErrors")
		expect(sql).toContain("s.totalSpans")
		expect(sql).toContain("AS errorRate")
		expect(sql).toContain("round(")
		expect(sql).toContain("e.affectedServicesCount")
		expect(sql).toContain("e.affectedTracesCount")
		expect(sql).toContain("FORMAT JSON")
	})

	it("applies rootOnly and services filters", () => {
		const q = errorsSummaryQuery({ rootOnly: true, services: ["api"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ParentSpanId = ''")
		expect(sql).toContain("ServiceName IN ('api')")
		expect(sql).toContain("FROM trace_list_mv")
	})

	it("applies deploymentEnvs filter", () => {
		const q = errorsSummaryQuery({ deploymentEnvs: ["production"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production')")
		expect(sql).toContain("FROM traces")
	})
})

// ---------------------------------------------------------------------------
// errorDetailTracesQuery
// ---------------------------------------------------------------------------

describe("errorDetailTracesQuery", () => {
	it("compiles trace-detail lookup with a small error TraceId subquery", () => {
		const q = errorDetailTracesQuery({ fingerprintHash: "111" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).not.toContain("INNER JOIN")
		expect(sql).toContain("TraceId IN (SELECT TraceId FROM (SELECT")
		expect(sql).toContain("GROUP BY TraceId")
		expect(sql).toContain("FROM trace_detail_spans")
		expect(sql).toContain("GROUP BY traceId")
		expect(sql).toContain("groupUniqArray(ServiceName)")
		expect(sql).toContain("ORDER BY startTime DESC")
		expect(sql).toContain("FORMAT JSON")
		// Error subquery references error_events, filtered by fingerprint hash
		expect(sql).toContain("FROM error_events")
		expect(sql).toContain("FingerprintHash = toUInt64('111')")
	})

	it("applies rootOnly filter", () => {
		const q = errorDetailTracesQuery({ fingerprintHash: "1", rootOnly: true })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ParentSpanId = ''")
	})

	it("applies services filter", () => {
		const q = errorDetailTracesQuery({ fingerprintHash: "1", services: ["api", "web"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName IN ('api', 'web')")
	})

	it("applies custom limit", () => {
		const q = errorDetailTracesQuery({ fingerprintHash: "1", limit: 20 })
		const { sql } = compileCH(q, baseParams)
		// The limit applies to the error subquery
		expect(sql).toContain("LIMIT 20")
	})
})

// ---------------------------------------------------------------------------
// errorsFacetsQuery
// ---------------------------------------------------------------------------

describe("errorsFacetsQuery", () => {
	it("compiles UNION ALL with 3 facet dimensions", () => {
		const q = errorsFacetsQuery({})
		const { sql } = compileUnion(q, baseParams)
		const unionCount = (sql.match(/UNION ALL/g) || []).length
		expect(unionCount).toBe(2) // 3 queries = 2 UNION ALL
		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("'service' AS facetType")
		expect(sql).toContain("'environment' AS facetType")
		expect(sql).toContain("'error_type' AS facetType")
	})

	it("applies all optional filters", () => {
		const q = errorsFacetsQuery({
			rootOnly: true,
			services: ["api"],
			deploymentEnvs: ["prod"],
			fingerprintHashes: ["123"],
		})
		const { sql } = compileUnion(q, baseParams)
		expect(sql).toContain("FROM error_events")
		expect(sql).not.toContain("FROM error_events_by_time")
		expect(sql).toContain("ParentSpanId = ''")
		expect(sql).toContain("ServiceName IN ('api')")
		expect(sql).toContain("DeploymentEnv IN ('prod')")
		expect(sql).toContain("FingerprintHash IN (toUInt64('123'))")
	})
})

// ---------------------------------------------------------------------------
// errorIssuesQuery
// ---------------------------------------------------------------------------

describe("errorIssuesQuery", () => {
	it("uses the time-ordered table for broad issue scans", () => {
		const q = errorIssuesQuery({ services: ["api"] })
		const { sql } = compileCH(q, baseParams)

		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("ServiceName IN ('api')")
	})

	it("uses the fingerprint-ordered table for constrained issue scans", () => {
		const q = errorIssuesQuery({ fingerprintHashes: ["123"] })
		const { sql } = compileCH(q, baseParams)

		expect(sql).toContain("FROM error_events")
		expect(sql).not.toContain("FROM error_events_by_time")
		expect(sql).toContain("FingerprintHash IN (toUInt64('123'))")
	})
})

// ---------------------------------------------------------------------------
// errorFingerprintsQuery
// ---------------------------------------------------------------------------

describe("errorFingerprintsQuery", () => {
	it("compiles a distinct-fingerprint scan scoped by service and environment", () => {
		const q = errorFingerprintsQuery({ services: ["api"], deploymentEnvs: ["production"] })
		const { sql } = compileCH(q, baseParams)

		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("toString(FingerprintHash) AS fingerprintHash")
		expect(sql).toContain("ServiceName IN ('api')")
		expect(sql).toContain("DeploymentEnv IN ('production')")
		expect(sql).toContain("GROUP BY fingerprintHash")
		expect(sql).toContain("LIMIT 1000")
		expect(sql).toContain("FORMAT JSON")
	})
})

// ---------------------------------------------------------------------------
// tracesFacetsQuery
// ---------------------------------------------------------------------------

describe("tracesFacetsQuery", () => {
	it("compiles UNION ALL with 7 facet dimensions", () => {
		const q = tracesFacetsQuery({})
		const { sql } = compileUnion(q, baseParams)
		const unionCount = (sql.match(/UNION ALL/g) || []).length
		expect(unionCount).toBe(6) // 7 queries = 6 UNION ALL
		expect(sql).toContain("'service' AS facetType")
		expect(sql).toContain("'spanName' AS facetType")
		expect(sql).toContain("'httpMethod' AS facetType")
		expect(sql).toContain("'httpStatus' AS facetType")
		expect(sql).toContain("'deploymentEnv' AS facetType")
		expect(sql).toContain("'serviceNamespace' AS facetType")
		expect(sql).toContain("'errorCount' AS facetType")
	})

	it("applies namespace filter", () => {
		const q = tracesFacetsQuery({ namespace: "team-a" })
		const { sql } = compileUnion(q, baseParams)
		expect(sql).toContain("ServiceNamespace = 'team-a'")
	})

	it("applies serviceName filter", () => {
		const q = tracesFacetsQuery({ serviceName: "api" })
		const { sql } = compileUnion(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
	})

	it("applies hasError filter", () => {
		const q = tracesFacetsQuery({ hasError: true })
		const { sql } = compileUnion(q, baseParams)
		expect(sql).toContain("HasError = 1")
	})

	it("applies contains match mode for serviceName", () => {
		const q = tracesFacetsQuery({
			serviceName: "api",
			matchModes: { serviceName: "contains" },
		})
		const { sql } = compileUnion(q, baseParams)
		expect(sql).toContain("positionCaseInsensitive(ServiceName, 'api') > 0")
	})

	it("applies attribute filter with correlated EXISTS", () => {
		const q = tracesFacetsQuery({
			attributeFilterKey: "http.method",
			attributeFilterValue: "GET",
		})
		const { sql } = compileUnion(q, baseParams)
		expect(sql).toContain("EXISTS")
		expect(sql).toContain("t_attr.SpanAttributes")
		expect(sql).toContain("http.method")
	})

	it("applies resource filter with correlated EXISTS", () => {
		const q = tracesFacetsQuery({
			resourceFilterKey: "host.name",
			resourceFilterValue: "server-1",
		})
		const { sql } = compileUnion(q, baseParams)
		expect(sql).toContain("EXISTS")
		expect(sql).toContain("t_res.ResourceAttributes")
		expect(sql).toContain("host.name")
	})

	it("compiles only the requested branch when facet is set", () => {
		const q = tracesFacetsQuery({ facet: "service" })
		const { sql } = compileUnion(q, baseParams)
		expect(sql).not.toContain("UNION ALL")
		expect(sql).toContain("'service' AS facetType")
		expect(sql).not.toContain("'spanName' AS facetType")
		expect(sql).not.toContain("'errorCount' AS facetType")
		// Same shape as the branch inside the full union: count-desc, limit 50.
		expect(sql).toContain("ORDER BY count DESC")
		expect(sql).toContain("LIMIT 50")
	})

	it("keeps the non-service branch empty-value guard when facet-scoped", () => {
		const q = tracesFacetsQuery({ facet: "deploymentEnv" })
		const { sql } = compileUnion(q, baseParams)
		expect(sql).not.toContain("UNION ALL")
		expect(sql).toContain("'deploymentEnv' AS facetType")
		expect(sql).toContain("DeploymentEnv != ''")
		expect(sql).toContain("LIMIT 20")
	})
})
