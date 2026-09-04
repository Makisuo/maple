import { describe, expect, it } from "vitest"
import { compileUnsafe, compileUnionUnsafe } from "@maple-dev/clickhouse-builder"
import {
	errorsByTypeQuery,
	errorsTimeseriesQuery,
	errorsSparkQuery,
	errorsSummaryQuery,
	errorDetailTracesQuery,
	errorsFacetsQuery,
	errorIssuesQuery,
	errorTickBootstrapIssuesQuery,
	errorTickIssuesQuery,
	errorFingerprintsQuery,
	tracesFacetsQuery,
} from "./errors"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
	bucketSeconds: 3600,
}

describe("errorsSparkQuery synthetic fingerprints", () => {
	it("drops fingerprints the warehouse cannot parse instead of failing the query", () => {
		// One alert-backed issue in the batch used to abort the whole request:
		// `toUInt64('alert:…')` is a query-level error, not a skipped row.
		const q = errorsSparkQuery({
			fingerprintHashes: ["123", "alert:28dd3389-5046-4ed7-8a8e-1bf147c1ddd6:all", "456"],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).not.toContain("alert:")
		expect(sql).toContain("toUInt64('123')")
		expect(sql).toContain("toUInt64('456')")
	})

	it("matches nothing when every fingerprint is synthetic", () => {
		// Must not emit `IN ()`, which is a ClickHouse syntax error.
		const q = errorsSparkQuery({ fingerprintHashes: ["alert:abc:all", "planetscale:maple:oom"] })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("1 = 0")
		expect(sql).not.toContain("IN ()")
	})
})

describe("errorsSparkQuery", () => {
	it("buckets many fingerprints in one fingerprint-keyed scan", () => {
		const q = errorsSparkQuery({ fingerprintHashes: ["123", "456"] })
		const { sql } = compileUnsafe(q, baseParams)
		// Fingerprint-filtered, so it prunes on (OrgId, FingerprintHash, Timestamp).
		expect(sql).toContain("FROM error_events")
		expect(sql).not.toContain("FROM error_events_by_time")
		// Identity UInt64 must survive JSON as a string.
		expect(sql).toContain("toString(FingerprintHash) AS fingerprintHash")
		expect(sql).toContain("GROUP BY fingerprintHash, bucket")
		expect(sql).toContain("ORDER BY bucket ASC")
	})

	it("applies the services filter", () => {
		const q = errorsSparkQuery({ fingerprintHashes: ["123"], services: ["api"] })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName IN")
	})
})

// errorsByTypeQuery

describe("errorsByTypeQuery", () => {
	it("compiles broad errors by type from the time-ordered error events table", () => {
		const q = errorsByTypeQuery({})
		const { sql } = compileUnsafe(q, baseParams)
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
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ParentSpanId = ''")
	})

	it("applies services filter", () => {
		const q = errorsByTypeQuery({ services: ["api", "web"] })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName IN ('api', 'web')")
	})

	it("applies deploymentEnvs filter", () => {
		const q = errorsByTypeQuery({ deploymentEnvs: ["production"] })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("DeploymentEnv IN ('production')")
	})

	it("filters by fingerprint hash (stable identity round-trip)", () => {
		const q = errorsByTypeQuery({ fingerprintHashes: ["12345678901234567890"] })
		const { sql } = compileUnsafe(q, baseParams)
		// Fingerprint-constrained scans use the fingerprint-ordered table.
		expect(sql).toContain("FROM error_events")
		expect(sql).not.toContain("FROM error_events_by_time")
		expect(sql).toContain("FingerprintHash IN (toUInt64('12345678901234567890'))")
	})

	it("applies custom limit", () => {
		const q = errorsByTypeQuery({ limit: 25 })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("LIMIT 25")
	})

	it("keeps only unexpected identities: outside the namespace, or a 5xx/envelope marker", () => {
		const q = errorsByTypeQuery({
			unexpectedIdentity: {
				namespacePrefix: "@maple/",
				markerLabels: ["@maple/api/http/Http5xxResponseError"],
			},
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ErrorLabel NOT LIKE '@maple/%'")
		expect(sql).toContain("ErrorLabel IN ('@maple/api/http/Http5xxResponseError')")
		expect(sql).toContain("any(StatusMessage) AS sampleMessage")
	})

	it("escapes LIKE wildcards in the namespace prefix", () => {
		const q = errorsByTypeQuery({ unexpectedIdentity: { namespacePrefix: "my_app%", markerLabels: [] } })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("NOT LIKE 'my\\\\_app\\\\%%'")
	})
})

// errorsTimeseriesQuery

describe("errorsTimeseriesQuery", () => {
	it("compiles error timeseries with bucket", () => {
		const q = errorsTimeseriesQuery({ fingerprintHash: "98765432109876543210" })
		const { sql } = compileUnsafe(q, baseParams)
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
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName IN ('api')")
	})
})

// errorsSummaryQuery

describe("errorsSummaryQuery", () => {
	it("compiles CROSS JOIN between filtered totals", () => {
		const q = errorsSummaryQuery({})
		const { sql } = compileUnsafe(q, baseParams)
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
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ParentSpanId = ''")
		expect(sql).toContain("ServiceName IN ('api')")
		expect(sql).toContain("FROM trace_list_mv")
	})

	it("applies deploymentEnvs filter", () => {
		const q = errorsSummaryQuery({ deploymentEnvs: ["production"] })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain(
			"coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) IN ('production')",
		)
		expect(sql).toContain("FROM traces")
	})
})

// errorDetailTracesQuery

describe("errorDetailTracesQuery", () => {
	it("compiles trace-detail lookup with a small error TraceId subquery", () => {
		const q = errorDetailTracesQuery({ fingerprintHash: "111" })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).not.toContain("INNER JOIN")
		// The subquery projects a single column (an IN list needs exactly one) from
		// the ranked error-trace query, now spliced as a typed CHQuery rather than a
		// pre-compiled SQL string — hence the `AS matching_traces` alias.
		expect(sql).toContain("TraceId IN (SELECT")
		expect(sql).toContain("AS matching_traces)")
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
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ParentSpanId = ''")
	})

	it("applies services filter", () => {
		const q = errorDetailTracesQuery({ fingerprintHash: "1", services: ["api", "web"] })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName IN ('api', 'web')")
	})

	it("applies custom limit", () => {
		const q = errorDetailTracesQuery({ fingerprintHash: "1", limit: 20 })
		const { sql } = compileUnsafe(q, baseParams)
		// The limit applies to the error subquery
		expect(sql).toContain("LIMIT 20")
	})
	it("reports the failing span rather than an arbitrary one", () => {
		const q = errorDetailTracesQuery({ fingerprintHash: "1" })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("anyIf(StatusMessage, StatusCode = 'Error') AS errorMessage")
		expect(sql).toContain("anyIf(SpanId, StatusCode = 'Error') AS errorSpanId")
		expect(sql).toContain("anyIf(SpanName, StatusCode = 'Error') AS errorSpanName")
		expect(sql).toContain("SpanAttributes['gen_ai.request.model']")
	})
})

// Exclusions on the fingerprint-resolving query. The errors list is issue-first until a facet is
// active, at which point it asks the warehouse which fingerprints survive — so an exclusion has to
// narrow that set or it never reaches the rows at all.

describe("errorsByTypeQuery exclusions", () => {
	it("emits NOT IN for every excluded dimension", () => {
		const q = errorsByTypeQuery({
			excludedServices: ["noisy"],
			excludedDeploymentEnvs: ["staging"],
			excludedErrorLabels: ["TimeoutError"],
			excludedServiceVersions: ["1.4.2"],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName NOT IN ('noisy')")
		expect(sql).toContain("DeploymentEnv NOT IN ('staging')")
		expect(sql).toContain("ErrorLabel NOT IN ('TimeoutError')")
		expect(sql).toContain("ServiceVersion NOT IN ('1.4.2')")
	})

	it("combines with the inclusion on the same dimension", () => {
		const q = errorsByTypeQuery({ services: ["api", "web"], excludedServices: ["noisy"] })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName IN ('api', 'web')")
		expect(sql).toContain("ServiceName NOT IN ('noisy')")
	})
})

// errorsFacetsQuery

describe("errorsFacetsQuery", () => {
	it("compiles UNION ALL with 4 facet dimensions", () => {
		const q = errorsFacetsQuery({})
		const { sql } = compileUnionUnsafe(q, baseParams)
		const unionCount = (sql.match(/UNION ALL/g) || []).length
		expect(unionCount).toBe(3) // 4 queries = 3 UNION ALL
		expect(sql).toContain("'service' AS facetType")
		expect(sql).toContain("'environment' AS facetType")
		expect(sql).toContain("'error_type' AS facetType")
		expect(sql).toContain("'version' AS facetType")
		expect(sql).toContain("ServiceVersion != ''")
	})

	it("filters by error label and service version", () => {
		// The "Error Type" sidebar section shipped without a filter behind it:
		// the route passed `errorTypes` into a request schema that had no such
		// field, so decode dropped it and selecting a type changed nothing.
		const q = errorsFacetsQuery({ errorLabels: ["TypeError"], serviceVersions: ["1.4.2"] })
		const { sql } = compileUnionUnsafe(q, baseParams)
		expect(sql).toContain("ErrorLabel IN ('TypeError')")
		expect(sql).toContain("ServiceVersion IN ('1.4.2')")
	})

	it("applies all optional filters", () => {
		const q = errorsFacetsQuery({
			rootOnly: true,
			services: ["api"],
			deploymentEnvs: ["prod"],
			fingerprintHashes: ["123"],
		})
		const { sql } = compileUnionUnsafe(q, baseParams)
		expect(sql).toContain("FROM error_events")
		expect(sql).not.toContain("FROM error_events_by_time")
		expect(sql).toContain("ParentSpanId = ''")
		expect(sql).toContain("ServiceName IN ('api')")
		expect(sql).toContain("DeploymentEnv IN ('prod')")
		expect(sql).toContain("FingerprintHash IN (toUInt64('123'))")
	})

	it("counts issues, not occurrences", () => {
		// The sidebar filters a list of issue rows, so its counts have to be in
		// issues. count() reported occurrences: one runaway dev loop read 183.1K
		// beside a list of a dozen issues.
		const q = errorsFacetsQuery({})
		const { sql } = compileUnionUnsafe(q, baseParams)
		expect(sql).toContain("uniq(FingerprintHash) AS count")
		expect(sql).not.toContain("count() AS count")
	})

	it("leaves each section's own dimension unfiltered", () => {
		// Ticking `api` must not zero every other service in the Service section,
		// or there is no way to widen the selection again.
		const q = errorsFacetsQuery({ services: ["api"], deploymentEnvs: ["prod"] })
		const { sql } = compileUnionUnsafe(q, baseParams)
		const branches = sql.split("UNION ALL")
		const serviceBranch = branches.find((b) => b.includes("'service' AS facetType"))
		const envBranch = branches.find((b) => b.includes("'environment' AS facetType"))

		expect(serviceBranch).not.toContain("ServiceName IN ('api')")
		expect(serviceBranch).toContain("DeploymentEnv IN ('prod')")
		expect(envBranch).toContain("ServiceName IN ('api')")
		expect(envBranch).not.toContain("DeploymentEnv IN ('prod')")
	})

	it("leaves a section's own EXCLUSIONS unfiltered too", () => {
		// The half that is easy to miss. If the Service section applied
		// `excludedServices`, the service you just excluded would count zero in the
		// very section you excluded it from — and there would be no row to untick.
		const q = errorsFacetsQuery({ excludedServices: ["noisy"], excludedDeploymentEnvs: ["staging"] })
		const { sql } = compileUnionUnsafe(q, baseParams)
		const branches = sql.split("UNION ALL")
		const serviceBranch = branches.find((b) => b.includes("'service' AS facetType"))
		const envBranch = branches.find((b) => b.includes("'environment' AS facetType"))

		expect(serviceBranch).not.toContain("ServiceName NOT IN ('noisy')")
		expect(serviceBranch).toContain("DeploymentEnv NOT IN ('staging')")
		expect(envBranch).toContain("ServiceName NOT IN ('noisy')")
		expect(envBranch).not.toContain("DeploymentEnv NOT IN ('staging')")
	})

	it("emits NOT IN for every excluded dimension", () => {
		const q = errorsFacetsQuery({
			excludedServices: ["noisy"],
			excludedDeploymentEnvs: ["staging"],
			excludedErrorLabels: ["TimeoutError"],
			excludedServiceVersions: ["1.4.2"],
		})
		const { sql } = compileUnionUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName NOT IN ('noisy')")
		expect(sql).toContain("DeploymentEnv NOT IN ('staging')")
		expect(sql).toContain("ErrorLabel NOT IN ('TimeoutError')")
		expect(sql).toContain("ServiceVersion NOT IN ('1.4.2')")
	})
})

// errorIssuesQuery

describe("errorIssuesQuery", () => {
	it("uses the time-ordered table for broad issue scans", () => {
		const q = errorIssuesQuery({ services: ["api"] })
		const { sql } = compileUnsafe(q, baseParams)

		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("ServiceName IN ('api')")
	})

	it("uses the fingerprint-ordered table for constrained issue scans", () => {
		const q = errorIssuesQuery({ fingerprintHashes: ["123"] })
		const { sql } = compileUnsafe(q, baseParams)

		expect(sql).toContain("FROM error_events")
		expect(sql).not.toContain("FROM error_events_by_time")
		expect(sql).toContain("FingerprintHash IN (toUInt64('123'))")
	})
})

describe("errorTickIssuesQuery", () => {
	it("scans the minute rollup with a half-open window and no truncating limit", () => {
		const { sql } = compileUnsafe(errorTickIssuesQuery(), baseParams)

		expect(sql).toContain("FROM error_fingerprints_minutely")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("Minute >= '2024-01-01 00:00:00'")
		expect(sql).toContain("Minute < '2024-01-02 00:00:00'")
		expect(sql).toContain("sum(OccurrenceCount) AS count")
		expect(sql).not.toContain("LIMIT")
	})
})

describe("errorTickBootstrapIssuesQuery", () => {
	it("bootstraps once from raw events without a truncating limit", () => {
		const { sql } = compileUnsafe(errorTickBootstrapIssuesQuery(), baseParams)

		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00'")
		expect(sql).toContain("Timestamp < '2024-01-02 00:00:00'")
		expect(sql).not.toContain("LIMIT")
	})
})

// errorFingerprintsQuery

describe("errorFingerprintsQuery", () => {
	it("compiles a distinct-fingerprint scan scoped by service and environment", () => {
		const q = errorFingerprintsQuery({ services: ["api"], deploymentEnvs: ["production"] })
		const { sql } = compileUnsafe(q, baseParams)

		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("toString(FingerprintHash) AS fingerprintHash")
		expect(sql).toContain("ServiceName IN ('api')")
		expect(sql).toContain("DeploymentEnv IN ('production')")
		expect(sql).toContain("GROUP BY fingerprintHash")
		expect(sql).toContain("LIMIT 1000")
		expect(sql).toContain("FORMAT JSON")
	})
})

// tracesFacetsQuery

describe("tracesFacetsQuery", () => {
	it("compiles UNION ALL with 7 facet dimensions", () => {
		const q = tracesFacetsQuery({})
		const { sql } = compileUnionUnsafe(q, baseParams)
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
		const { sql } = compileUnionUnsafe(q, baseParams)
		expect(sql).toContain("ServiceNamespace = 'team-a'")
	})

	it("applies serviceName filter", () => {
		const q = tracesFacetsQuery({ serviceName: "api" })
		const { sql } = compileUnionUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
	})

	it("applies hasError filter", () => {
		const q = tracesFacetsQuery({ hasError: true })
		const { sql } = compileUnionUnsafe(q, baseParams)
		expect(sql).toContain("HasError = 1")
	})

	it("applies contains match mode for serviceName", () => {
		const q = tracesFacetsQuery({
			serviceName: "api",
			matchModes: { serviceName: "contains" },
		})
		const { sql } = compileUnionUnsafe(q, baseParams)
		expect(sql).toContain("positionCaseInsensitive(ServiceName, 'api') > 0")
	})

	it("applies attribute filter with correlated EXISTS", () => {
		const q = tracesFacetsQuery({
			attributeFilterKey: "http.method",
			attributeFilterValue: "GET",
		})
		const { sql } = compileUnionUnsafe(q, baseParams)
		expect(sql).toContain("EXISTS")
		expect(sql).toContain("t_attr.SpanAttributes")
		expect(sql).toContain("http.method")
	})

	it("applies resource filter with correlated EXISTS", () => {
		const q = tracesFacetsQuery({
			resourceFilterKey: "host.name",
			resourceFilterValue: "server-1",
		})
		const { sql } = compileUnionUnsafe(q, baseParams)
		expect(sql).toContain("EXISTS")
		expect(sql).toContain("t_res.ResourceAttributes")
		expect(sql).toContain("host.name")
	})

	it("compiles only the requested branch when facet is set", () => {
		const q = tracesFacetsQuery({ facet: "service" })
		const { sql } = compileUnionUnsafe(q, baseParams)
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
		const { sql } = compileUnionUnsafe(q, baseParams)
		expect(sql).not.toContain("UNION ALL")
		expect(sql).toContain("'deploymentEnv' AS facetType")
		expect(sql).toContain("DeploymentEnv != ''")
		expect(sql).toContain("LIMIT 20")
	})
})
