import { describe, expect, it } from "bun:test"
import { compileCH, compileUnion } from "../compile"
import {
  logsTimeseriesQuery,
  logsBreakdownQuery,
  logsCountQuery,
  logsListQuery,
  errorRateByServiceQuery,
  logsFacetsQuery,
} from "./logs"

const baseParams = {
  orgId: "org_1",
  startTime: "2024-01-01 00:00:00",
  endTime: "2024-01-02 00:00:00",
  bucketSeconds: 3600,
}

// ---------------------------------------------------------------------------
// logsTimeseriesQuery
// ---------------------------------------------------------------------------

describe("logsTimeseriesQuery", () => {
  it("compiles basic timeseries with no groupBy", () => {
    const q = logsTimeseriesQuery({})
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM logs")
    expect(sql).toContain("toStartOfInterval")
    expect(sql).toContain("INTERVAL 3600 SECOND")
    expect(sql).toContain("'all' AS groupName")
    expect(sql).toContain("count() AS count")
    expect(sql).toContain("GROUP BY bucket, groupName")
    expect(sql).toContain("ORDER BY bucket ASC, groupName ASC")
    expect(sql).toContain("FORMAT JSON")
  })

  it("groups by service", () => {
    const q = logsTimeseriesQuery({ groupBy: ["service"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("toString(ServiceName)")
    expect(sql).not.toContain("'all' AS groupName")
  })

  it("groups by severity", () => {
    const q = logsTimeseriesQuery({ groupBy: ["severity"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("toString(SeverityText)")
  })

  it("groups by service and severity", () => {
    const q = logsTimeseriesQuery({ groupBy: ["service", "severity"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("arrayFilter")
    expect(sql).toContain("arrayStringConcat")
  })

  it("applies serviceName filter", () => {
    const q = logsTimeseriesQuery({ serviceName: "api" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName = 'api'")
  })

  it("applies severity filter", () => {
    const q = logsTimeseriesQuery({ severity: "ERROR" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SeverityText = 'ERROR'")
  })
})

// ---------------------------------------------------------------------------
// logsBreakdownQuery
// ---------------------------------------------------------------------------

describe("logsBreakdownQuery", () => {
  it("compiles breakdown by service", () => {
    const q = logsBreakdownQuery({ groupBy: "service" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM logs")
    expect(sql).toContain("ServiceName AS name")
    expect(sql).toContain("count() AS count")
    expect(sql).toContain("GROUP BY name")
    expect(sql).toContain("ORDER BY count DESC")
    expect(sql).toContain("LIMIT 10")
    expect(sql).toContain("FORMAT JSON")
  })

  it("compiles breakdown by severity", () => {
    const q = logsBreakdownQuery({ groupBy: "severity" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SeverityText AS name")
  })

  it("applies optional filters", () => {
    const q = logsBreakdownQuery({ groupBy: "service", serviceName: "api", severity: "ERROR" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName = 'api'")
    expect(sql).toContain("SeverityText = 'ERROR'")
  })

  it("applies custom limit", () => {
    const q = logsBreakdownQuery({ groupBy: "service", limit: 25 })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("LIMIT 25")
  })
})

// ---------------------------------------------------------------------------
// logsCountQuery
// ---------------------------------------------------------------------------

describe("logsCountQuery", () => {
  it("compiles basic count", () => {
    const q = logsCountQuery({})
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM logs")
    expect(sql).toContain("count() AS total")
    expect(sql).toContain("FORMAT JSON")
    expect(sql).not.toContain("GROUP BY")
    expect(sql).not.toContain("ORDER BY")
  })

  it("applies search filter", () => {
    const q = logsCountQuery({ search: "exception" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("Body ILIKE '%exception%'")
  })

  it("applies traceId filter", () => {
    const q = logsCountQuery({ traceId: "abc123" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("TraceId = 'abc123'")
  })

  it("applies all filters simultaneously", () => {
    const q = logsCountQuery({ serviceName: "api", severity: "ERROR", search: "timeout" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName = 'api'")
    expect(sql).toContain("SeverityText = 'ERROR'")
    expect(sql).toContain("Body ILIKE '%timeout%'")
  })
})

// ---------------------------------------------------------------------------
// logsListQuery
// ---------------------------------------------------------------------------

describe("logsListQuery", () => {
  it("compiles basic list with all columns", () => {
    const q = logsListQuery({})
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM logs")
    expect(sql).toContain("Timestamp AS timestamp")
    expect(sql).toContain("SeverityText AS severityText")
    expect(sql).toContain("SeverityNumber AS severityNumber")
    expect(sql).toContain("ServiceName AS serviceName")
    expect(sql).toContain("Body AS body")
    expect(sql).toContain("TraceId AS traceId")
    expect(sql).toContain("SpanId AS spanId")
    expect(sql).toContain("toJSONString(LogAttributes) AS logAttributes")
    expect(sql).toContain("toJSONString(ResourceAttributes) AS resourceAttributes")
    expect(sql).toContain("ORDER BY timestamp DESC")
    expect(sql).toContain("LIMIT 50")
    expect(sql).toContain("FORMAT JSON")
  })

  it("applies cursor pagination", () => {
    const q = logsListQuery({ cursor: "2024-01-01T12:00:00" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("Timestamp < '2024-01-01T12:00:00'")
  })

  it("applies custom limit", () => {
    const q = logsListQuery({ limit: 100 })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("LIMIT 100")
  })

  it("applies all filters simultaneously", () => {
    const q = logsListQuery({
      serviceName: "api",
      severity: "ERROR",
      traceId: "trace123",
      spanId: "span456",
      search: "timeout",
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName = 'api'")
    expect(sql).toContain("SeverityText = 'ERROR'")
    expect(sql).toContain("TraceId = 'trace123'")
    expect(sql).toContain("SpanId = 'span456'")
    expect(sql).toContain("Body ILIKE '%timeout%'")
  })

  it("applies minSeverity filter", () => {
    const q = logsListQuery({ minSeverity: 9 })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SeverityNumber >= 9")
  })
})

// ---------------------------------------------------------------------------
// errorRateByServiceQuery
// ---------------------------------------------------------------------------

describe("errorRateByServiceQuery", () => {
  it("compiles error rate by service", () => {
    const q = errorRateByServiceQuery()
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM logs")
    expect(sql).toContain("ServiceName AS serviceName")
    expect(sql).toContain("count() AS totalLogs")
    expect(sql).toContain("countIf(")
    expect(sql).toContain("IN ('ERROR', 'FATAL')")
    expect(sql).toContain("AS errorLogs")
    expect(sql).toContain("round(")
    expect(sql).toContain("AS errorRate")
    expect(sql).toContain("GROUP BY serviceName")
    expect(sql).toContain("ORDER BY errorRate DESC")
    expect(sql).toContain("FORMAT JSON")
  })
})

// ---------------------------------------------------------------------------
// logsFacetsQuery
// ---------------------------------------------------------------------------

describe("logsFacetsQuery", () => {
  it("compiles UNION ALL with severity, service, and deploymentEnv facets", () => {
    const q = logsFacetsQuery({})
    const { sql } = compileUnion(q, baseParams)
    const unionCount = (sql.match(/UNION ALL/g) || []).length
    expect(unionCount).toBe(2)
    expect(sql).toContain("'severity' AS facetType")
    expect(sql).toContain("'service' AS facetType")
    expect(sql).toContain("'deploymentEnv' AS facetType")
    expect(sql).toContain("ResourceAttributes['deployment.environment']")
    expect(sql).toContain("ORDER BY count DESC")
  })

  it("applies optional filters", () => {
    const q = logsFacetsQuery({ serviceName: "api", severity: "ERROR" })
    const { sql } = compileUnion(q, baseParams)
    expect(sql).toContain("ServiceName = 'api'")
    expect(sql).toContain("SeverityText = 'ERROR'")
  })
})

// ---------------------------------------------------------------------------
// environments filter (applies to all logs queries via ResourceAttributes)
// ---------------------------------------------------------------------------

describe("environments filter", () => {
  it("logsListQuery filters by a single environment", () => {
    const q = logsListQuery({ environments: ["production"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production')")
  })

  it("logsListQuery filters by multiple environments", () => {
    const q = logsListQuery({ environments: ["production", "staging"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production', 'staging')")
  })

  it("logsListQuery uses positionCaseInsensitive for single-value contains mode", () => {
    const q = logsListQuery({ environments: ["prod"], matchModes: { deploymentEnv: "contains" } })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("positionCaseInsensitive(ResourceAttributes['deployment.environment'], 'prod')")
  })

  it("logsCountQuery applies environments filter", () => {
    const q = logsCountQuery({ environments: ["production"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production')")
  })

  it("logsTimeseriesQuery applies environments filter", () => {
    const q = logsTimeseriesQuery({ environments: ["production"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production')")
  })

  it("logsFacetsQuery applies environments filter to all branches", () => {
    const q = logsFacetsQuery({ environments: ["production"] })
    const { sql } = compileUnion(q, baseParams)
    const matches = sql.match(/ResourceAttributes\['deployment\.environment'\] IN \('production'\)/g) || []
    expect(matches.length).toBe(3)
  })
})
