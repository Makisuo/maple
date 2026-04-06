import { describe, expect, it } from "bun:test"
import { compileCH, compileUnion } from "../compile"
import {
  errorsByTypeQuery,
  errorsTimeseriesQuery,
  errorsSummaryQuery,
  errorDetailTracesQuery,
  errorsFacetsQuery,
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
  it("compiles basic errors by type", () => {
    const q = errorsByTypeQuery({})
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM error_spans")
    expect(sql).toContain("AS errorType")
    expect(sql).toContain("count() AS count")
    expect(sql).toContain("uniq(ServiceName) AS affectedServicesCount")
    expect(sql).toContain("min(Timestamp) AS firstSeen")
    expect(sql).toContain("max(Timestamp) AS lastSeen")
    expect(sql).toContain("GROUP BY errorType")
    expect(sql).toContain("ORDER BY count DESC")
    expect(sql).toContain("LIMIT 50")
    expect(sql).toContain("FORMAT JSON")
    // Fingerprint expression should contain position/left/multiIf
    expect(sql).toContain("left(")
    expect(sql).toContain("multiIf(")
    expect(sql).toContain("position(")
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

  it("applies errorTypes filter", () => {
    const q = errorsByTypeQuery({ errorTypes: ["TimeoutError"] })
    const { sql } = compileCH(q, baseParams)
    // The fingerprint expression should appear in WHERE with IN
    expect(sql).toContain("IN ('TimeoutError')")
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
    const q = errorsTimeseriesQuery({ errorType: "NullPointerException" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM error_spans")
    expect(sql).toContain("toStartOfInterval")
    expect(sql).toContain("INTERVAL 3600 SECOND")
    expect(sql).toContain("count() AS count")
    expect(sql).toContain("GROUP BY bucket")
    expect(sql).toContain("ORDER BY bucket ASC")
    // Fingerprint match in WHERE
    expect(sql).toContain("NullPointerException")
  })

  it("applies services filter", () => {
    const q = errorsTimeseriesQuery({ errorType: "X", services: ["api"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName IN ('api')")
  })
})

// ---------------------------------------------------------------------------
// errorsSummaryQuery
// ---------------------------------------------------------------------------

describe("errorsSummaryQuery", () => {
  it("compiles CROSS JOIN between error_spans and service_usage", () => {
    const q = errorsSummaryQuery({})
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("CROSS JOIN")
    expect(sql).toContain("FROM (SELECT")
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
  })

  it("applies deploymentEnvs filter", () => {
    const q = errorsSummaryQuery({ deploymentEnvs: ["production"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("DeploymentEnv IN ('production')")
  })
})

// ---------------------------------------------------------------------------
// errorDetailTracesQuery
// ---------------------------------------------------------------------------

describe("errorDetailTracesQuery", () => {
  it("compiles INNER JOIN with error subquery", () => {
    const q = errorDetailTracesQuery({ errorType: "NullPointerException" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("INNER JOIN")
    expect(sql).toContain("GROUP BY TraceId")
    expect(sql).toContain("FROM traces")
    expect(sql).toContain("GROUP BY traceId")
    expect(sql).toContain("groupUniqArray(traces.ServiceName)")
    expect(sql).toContain("ORDER BY startTime DESC")
    expect(sql).toContain("FORMAT JSON")
    // Error subquery references error_spans
    expect(sql).toContain("FROM error_spans")
    // Fingerprint match
    expect(sql).toContain("NullPointerException")
  })

  it("applies rootOnly filter", () => {
    const q = errorDetailTracesQuery({ errorType: "X", rootOnly: true })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ParentSpanId = ''")
  })

  it("applies services filter", () => {
    const q = errorDetailTracesQuery({ errorType: "X", services: ["api", "web"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName IN ('api', 'web')")
  })

  it("applies custom limit", () => {
    const q = errorDetailTracesQuery({ errorType: "X", limit: 20 })
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
    expect(sql).toContain("'service' AS facetType")
    expect(sql).toContain("'environment' AS facetType")
    expect(sql).toContain("'error_type' AS facetType")
  })

  it("applies all optional filters", () => {
    const q = errorsFacetsQuery({
      rootOnly: true,
      services: ["api"],
      deploymentEnvs: ["prod"],
      errorTypes: ["TimeoutError"],
    })
    const { sql } = compileUnion(q, baseParams)
    expect(sql).toContain("ParentSpanId = ''")
    expect(sql).toContain("ServiceName IN ('api')")
    expect(sql).toContain("DeploymentEnv IN ('prod')")
    expect(sql).toContain("IN ('TimeoutError')")
  })
})

// ---------------------------------------------------------------------------
// tracesFacetsQuery
// ---------------------------------------------------------------------------

describe("tracesFacetsQuery", () => {
  it("compiles UNION ALL with 6 facet dimensions", () => {
    const q = tracesFacetsQuery({})
    const { sql } = compileUnion(q, baseParams)
    const unionCount = (sql.match(/UNION ALL/g) || []).length
    expect(unionCount).toBe(5) // 6 queries = 5 UNION ALL
    expect(sql).toContain("'service' AS facetType")
    expect(sql).toContain("'spanName' AS facetType")
    expect(sql).toContain("'httpMethod' AS facetType")
    expect(sql).toContain("'httpStatus' AS facetType")
    expect(sql).toContain("'deploymentEnv' AS facetType")
    expect(sql).toContain("'errorCount' AS facetType")
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
})
