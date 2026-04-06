import { describe, expect, it } from "bun:test"
import * as CH from "./index"
import { compileCH, compileUnion } from "./compile"
import { tracesTimeseriesQuery, tracesBreakdownQuery, tracesListQuery } from "./queries/traces"
import { logsFacetsQuery } from "./queries/logs"
import { servicesFacetsQuery } from "./queries/services"
import { metricsSummaryQuery } from "./queries/metrics"
import { spanAttributeValuesQuery, resourceAttributeValuesQuery } from "./queries/attribute-keys"
import { tracesDurationStatsQuery, spanHierarchyQuery } from "./queries/errors"
import { unionAll } from "./union"

// ---------------------------------------------------------------------------
// Core DSL tests
// ---------------------------------------------------------------------------

describe("CH.from / select / where / compile", () => {
  const TestTable = CH.table("test_table", {
    Id: CH.string,
    Name: CH.string,
    Value: CH.uint64,
    Attrs: CH.map(CH.string, CH.string),
  })

  it("compiles a basic select", () => {
    const q = CH.from(TestTable)
      .select(($) => ({
        id: $.Id,
        name: $.Name,
      }))
      .format("JSON")

    const { sql } = compileCH(q, {})
    expect(sql).toContain("SELECT")
    expect(sql).toContain("Id AS id")
    expect(sql).toContain("Name AS name")
    expect(sql).toContain("FROM test_table")
    expect(sql).toContain("FORMAT JSON")
  })

  it("compiles with WHERE conditions", () => {
    const q = CH.from(TestTable)
      .select(($) => ({
        id: $.Id,
        count: CH.count(),
      }))
      .where(($) => [
        $.Id.eq(CH.param.string("orgId")),
        $.Name.eq("test"),
      ])
      .groupBy("id")

    const { sql } = compileCH(q, { orgId: "org_123" })
    expect(sql).toContain("Id AS id")
    expect(sql).toContain("count() AS count")
    expect(sql).toContain("Id = 'org_123'")
    expect(sql).toContain("Name = 'test'")
    expect(sql).toContain("GROUP BY id")
  })

  it("compiles with orderBy and limit", () => {
    const q = CH.from(TestTable)
      .select(($) => ({
        name: $.Name,
        count: CH.count(),
      }))
      .groupBy("name")
      .orderBy(["count", "desc"])
      .limit(10)
      .format("JSON")

    const { sql } = compileCH(q, {})
    expect(sql).toContain("ORDER BY count DESC")
    expect(sql).toContain("LIMIT 10")
  })

  it("compiles map access", () => {
    const q = CH.from(TestTable)
      .select(($) => ({
        method: $.Attrs.get("http.method"),
      }))

    const { sql } = compileCH(q, {})
    expect(sql).toContain("Attrs['http.method'] AS method")
  })

  it("compiles arithmetic expressions", () => {
    const q = CH.from(TestTable)
      .select(($) => ({
        avgMs: CH.avg($.Value).div(1000000),
      }))

    const { sql } = compileCH(q, {})
    expect(sql).toContain("avg(Value) / 1000000 AS avgMs")
  })

  it("compiles aggregate functions", () => {
    const q = CH.from(TestTable)
      .select(($) => ({
        cnt: CH.count(),
        total: CH.sum($.Value),
        p95: CH.quantile(0.95)($.Value),
      }))

    const { sql } = compileCH(q, {})
    expect(sql).toContain("count() AS cnt")
    expect(sql).toContain("sum(Value) AS total")
    expect(sql).toContain("quantile(0.95)(Value) AS p95")
  })

  it("skips undefined WHERE conditions", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [
        $.Id.eq("test"),
        CH.when(undefined, () => $.Name.eq("nope")),
        CH.when("hello", (v) => $.Name.eq(v)),
      ])

    const { sql } = compileCH(q, {})
    expect(sql).toContain("Id = 'test'")
    expect(sql).toContain("Name = 'hello'")
    expect(sql).not.toContain("nope")
  })

  it("resolves params with special characters", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [$.Id.eq(CH.param.string("name"))])

    const { sql } = compileCH(q, { name: "it's-a-test" })
    expect(sql).toContain("Id = 'it\\'s-a-test'")
  })

  it("compiles toStartOfInterval", () => {
    const q = CH.from(TestTable)
      .select(($) => ({
        bucket: CH.toStartOfInterval(CH.rawExpr<string>("Timestamp"), 3600),
      }))

    const { sql } = compileCH(q, {})
    expect(sql).toContain("toStartOfInterval(Timestamp, INTERVAL 3600 SECOND) AS bucket")
  })

  it("compiles if_ expressions", () => {
    const q = CH.from(TestTable)
      .select(($) => ({
        errorRate: CH.if_(CH.count().gt(0), CH.countIf($.Name.eq("Error")), CH.lit(0)),
      }))

    const { sql } = compileCH(q, {})
    expect(sql).toContain("if(count() > 0, countIf(Name = 'Error'), 0) AS errorRate")
  })

  it("compiles inList conditions", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [CH.inList($.Name, ["a", "b", "c"])])

    const { sql } = compileCH(q, {})
    expect(sql).toContain("Name IN ('a', 'b', 'c')")
  })

  it("compiles column shorthand select", () => {
    const q = CH.from(TestTable).select("Id", "Name", "Value")

    const { sql } = compileCH(q, {})
    expect(sql).toContain("Id AS Id")
    expect(sql).toContain("Name AS Name")
    expect(sql).toContain("Value AS Value")
    expect(sql).toContain("FROM test_table")
  })

  it("compiles in_() on expressions", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [$.Name.in_("alice", "bob", "charlie")])

    const { sql } = compileCH(q, {})
    expect(sql).toContain("Name IN ('alice', 'bob', 'charlie')")
  })

  it("compiles arrayOf()", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ names: CH.arrayOf($.Name) }))

    const { sql } = compileCH(q, {})
    expect(sql).toContain("[Name] AS names")
  })
})

// ---------------------------------------------------------------------------
// Traces timeseries query — parity with buildTracesTimeseriesSQL
// ---------------------------------------------------------------------------

describe("tracesTimeseriesQuery", () => {
  const baseParams = {
    orgId: "org_123",
    startTime: "2024-01-01 00:00:00",
    endTime: "2024-01-02 00:00:00",
    bucketSeconds: 3600,
  }

  it("builds basic count timeseries", () => {
    const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SELECT")
    expect(sql).toContain("FROM traces")
    expect(sql).toContain("OrgId = 'org_123'")
    expect(sql).toContain("count() AS count")
    expect(sql).toContain("INTERVAL 3600 SECOND")
    expect(sql).toContain("GROUP BY bucket, groupName")
    expect(sql).toContain("ORDER BY bucket ASC, groupName ASC")
    expect(sql).toContain("FORMAT JSON")
    expect(sql).toContain("'all'")
    // count metric should not include quantiles
    expect(sql).toContain("0 AS p50Duration")
  })

  it("builds apdex timeseries with threshold", () => {
    const q = tracesTimeseriesQuery({ metric: "apdex", needsSampling: false, apdexThresholdMs: 250 })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("countIf(Duration / 1000000 < 250) AS satisfiedCount")
    expect(sql).toContain("toleratingCount")
    expect(sql).toContain("apdexScore")
  })

  it("builds p95 duration timeseries", () => {
    const q = tracesTimeseriesQuery({ metric: "p95_duration", needsSampling: false })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("quantile(0.5)(Duration) / 1000000 AS p50Duration")
    expect(sql).toContain("quantile(0.95)(Duration) / 1000000 AS p95Duration")
    expect(sql).toContain("quantile(0.99)(Duration) / 1000000 AS p99Duration")
  })

  it("builds error_rate timeseries", () => {
    const q = tracesTimeseriesQuery({ metric: "error_rate", needsSampling: false })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("countIf(StatusCode = 'Error') * 100 / count(), 0) AS errorRate")
  })

  it("includes sampling columns when needsSampling is true", () => {
    const q = tracesTimeseriesQuery({ metric: "count", needsSampling: true })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("sampledSpanCount")
    expect(sql).toContain("unsampledSpanCount")
    expect(sql).toContain("dominantThreshold")
    expect(sql).toContain("TraceState LIKE '%th:%'")
  })

  it("excludes sampling columns when needsSampling is false", () => {
    const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("0 AS sampledSpanCount")
    expect(sql).toContain("0 AS unsampledSpanCount")
  })

  it("groups by service", () => {
    const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, groupBy: ["service"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("toString(ServiceName)")
    expect(sql).toContain("AS groupName")
  })

  it("groups by span_name", () => {
    const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, groupBy: ["span_name"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("toString(SpanName)")
  })

  it("groups by multiple dimensions", () => {
    const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, groupBy: ["service", "status_code"] })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("arrayStringConcat")
    expect(sql).toContain("arrayFilter")
  })

  it("groups by attribute with keys", () => {
    const q = tracesTimeseriesQuery({
      metric: "count", needsSampling: false,
      groupBy: ["attribute"],
      groupByAttributeKeys: ["http.route"],
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SpanAttributes['http.route']")
  })

  it("uses traces table when rootOnly (MV disabled)", () => {
    const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, rootOnly: true })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM traces")
    expect(sql).toContain("SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''")
  })

  it("uses traces table when not rootOnly", () => {
    const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM traces")
  })

  it("includes commitShas filter with rootOnly", () => {
    const q = tracesTimeseriesQuery({
      metric: "count", needsSampling: false,
      rootOnly: true, commitShas: ["abc123"],
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM traces")
    expect(sql).toContain("SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''")
    expect(sql).toContain("deployment.commit_sha")
  })

  it("filters by serviceName", () => {
    const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, serviceName: "api-service" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName = 'api-service'")
  })

  it("filters by spanName", () => {
    const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, spanName: "GET /users" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SpanName = 'GET /users'")
  })

  it("filters errorsOnly", () => {
    const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, errorsOnly: true })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("StatusCode = 'Error'")
  })

  it("filters errorsOnly with rootOnly", () => {
    const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, rootOnly: true, errorsOnly: true })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("StatusCode = 'Error'")
  })

  it("filters by environments", () => {
    const q = tracesTimeseriesQuery({
      metric: "count", needsSampling: false,
      environments: ["production", "staging"],
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production', 'staging')")
  })

  it("filters by environments with rootOnly", () => {
    const q = tracesTimeseriesQuery({
      metric: "count", needsSampling: false,
      rootOnly: true, environments: ["production"],
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("deployment.environment") // raw table uses ResourceAttributes
  })

  it("filters by attribute filters (equals)", () => {
    const q = tracesTimeseriesQuery({
      metric: "count", needsSampling: false,
      attributeFilters: [{ key: "http.status_code", value: "200", mode: "equals" }],
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SpanAttributes['http.status_code'] = '200'")
  })

  it("filters by attribute filters (exists)", () => {
    const q = tracesTimeseriesQuery({
      metric: "count", needsSampling: false,
      attributeFilters: [{ key: "http.route", mode: "exists" }],
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("mapContains(SpanAttributes, 'http.route')")
  })

  it("filters by attribute filters (contains)", () => {
    const q = tracesTimeseriesQuery({
      metric: "count", needsSampling: false,
      attributeFilters: [{ key: "http.route", value: "/api", mode: "contains" }],
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("positionCaseInsensitive(SpanAttributes['http.route'], '/api') > 0")
  })

  it("filters by attribute filters (gt)", () => {
    const q = tracesTimeseriesQuery({
      metric: "count", needsSampling: false,
      attributeFilters: [{ key: "http.status_code", value: "400", mode: "gt" }],
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("toFloat64OrZero(SpanAttributes['http.status_code']) > 400")
  })

  it("filters by resource attribute filters", () => {
    const q = tracesTimeseriesQuery({
      metric: "count", needsSampling: false,
      resourceAttributeFilters: [{ key: "host.name", value: "server-1", mode: "equals" }],
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ResourceAttributes['host.name'] = 'server-1'")
  })

  it("filters attribute with rootOnly on raw table", () => {
    const q = tracesTimeseriesQuery({
      metric: "count", needsSampling: false,
      rootOnly: true,
      attributeFilters: [{ key: "http.method", value: "GET", mode: "equals" }],
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM traces")
    expect(sql).toContain("SpanAttributes['http.method'] = 'GET'")
  })

  it("escapes special characters in filter values", () => {
    const q = tracesTimeseriesQuery({
      metric: "count", needsSampling: false,
      serviceName: "it's-a-service",
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName = 'it\\'s-a-service'")
  })
})

// ---------------------------------------------------------------------------
// Traces breakdown query — parity with buildTracesBreakdownSQL
// ---------------------------------------------------------------------------

describe("tracesBreakdownQuery", () => {
  const baseParams = {
    orgId: "org_123",
    startTime: "2024-01-01 00:00:00",
    endTime: "2024-01-02 00:00:00",
  }

  it("builds basic breakdown by service", () => {
    const q = tracesBreakdownQuery({ metric: "count", groupBy: "service" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SELECT")
    expect(sql).toContain("ServiceName AS name")
    expect(sql).toContain("count() AS count")
    expect(sql).toContain("GROUP BY name")
    expect(sql).toContain("ORDER BY count DESC")
    expect(sql).toContain("LIMIT 10")
    expect(sql).toContain("FORMAT JSON")
  })

  it("groups by span_name", () => {
    const q = tracesBreakdownQuery({ metric: "count", groupBy: "span_name" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SpanName AS name")
  })

  it("groups by status_code", () => {
    const q = tracesBreakdownQuery({ metric: "count", groupBy: "status_code" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("StatusCode AS name")
  })

  it("groups by http_method", () => {
    const q = tracesBreakdownQuery({ metric: "count", groupBy: "http_method" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SpanAttributes['http.method'] AS name")
  })

  it("groups by custom attribute", () => {
    const q = tracesBreakdownQuery({
      metric: "count", groupBy: "attribute",
      groupByAttributeKey: "rpc.service",
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SpanAttributes['rpc.service'] AS name")
  })

  it("applies custom limit", () => {
    const q = tracesBreakdownQuery({ metric: "count", groupBy: "service", limit: 25 })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("LIMIT 25")
  })

  it("uses default limit of 10", () => {
    const q = tracesBreakdownQuery({ metric: "count", groupBy: "service" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("LIMIT 10")
  })

  it("includes apdex columns for apdex metric", () => {
    const q = tracesBreakdownQuery({ metric: "apdex", groupBy: "service", apdexThresholdMs: 300 })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("countIf(Duration / 1000000 < 300) AS satisfiedCount")
    expect(sql).toContain("apdexScore")
  })

  it("includes quantile columns for p99 metric", () => {
    const q = tracesBreakdownQuery({ metric: "p99_duration", groupBy: "service" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("quantile(0.99)(Duration) / 1000000 AS p99Duration")
  })

  it("applies WHERE filters", () => {
    const q = tracesBreakdownQuery({
      metric: "count", groupBy: "service",
      serviceName: "api", errorsOnly: true,
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName = 'api'")
    expect(sql).toContain("StatusCode = 'Error'")
  })
})

// ---------------------------------------------------------------------------
// Traces list query
// ---------------------------------------------------------------------------

describe("tracesListQuery", () => {
  const baseParams = {
    orgId: "org_123",
    startTime: "2024-01-01 00:00:00",
    endTime: "2024-01-02 00:00:00",
  }

  it("builds basic list query", () => {
    const q = tracesListQuery({})
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SELECT")
    expect(sql).toContain("FROM traces")
    expect(sql).toContain("TraceId AS traceId")
    expect(sql).toContain("Duration / 1000000 AS durationMs")
    expect(sql).toContain("SpanAttributes AS spanAttributes")
    expect(sql).toContain("ResourceAttributes AS resourceAttributes")
    expect(sql).toContain("ORDER BY timestamp DESC")
    expect(sql).toContain("LIMIT 25")
    expect(sql).toContain("FORMAT JSON")
  })

  it("applies custom limit", () => {
    const q = tracesListQuery({ limit: 50 })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("LIMIT 50")
  })

  it("filters by service", () => {
    const q = tracesListQuery({ serviceName: "api" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ServiceName = 'api'")
  })

  it("uses traces table when rootOnly (MV disabled)", () => {
    const q = tracesListQuery({ rootOnly: true })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("FROM traces")
  })
})

// ---------------------------------------------------------------------------
// UNION ALL queries
// ---------------------------------------------------------------------------

describe("unionAll", () => {
  const TestTable = CH.table("test_table", {
    Id: CH.string,
    Name: CH.string,
    Value: CH.uint64,
  })

  it("compiles two queries with UNION ALL", () => {
    const q1 = CH.from(TestTable)
      .select(($) => ({
        name: $.Name,
        count: CH.count(),
        facet: CH.lit("a"),
      }))
      .where(($) => [$.Id.eq("1")])
      .groupBy("name")

    const q2 = CH.from(TestTable)
      .select(($) => ({
        name: $.Id,
        count: CH.count(),
        facet: CH.lit("b"),
      }))
      .where(($) => [$.Id.eq("2")])
      .groupBy("name")

    const union = unionAll(q1, q2).format("JSON")
    const { sql } = compileUnion(union, {})
    expect(sql).toContain("UNION ALL")
    expect(sql).toContain("'a' AS facet")
    expect(sql).toContain("'b' AS facet")
    expect(sql).toContain("FORMAT JSON")
    // Sub-queries should NOT have FORMAT
    const parts = sql.split("UNION ALL")
    expect(parts[0]).not.toContain("FORMAT")
  })

  it("wraps with outer ORDER BY and LIMIT", () => {
    const q1 = CH.from(TestTable)
      .select(($) => ({ name: $.Name, count: CH.count() }))
      .groupBy("name")

    const q2 = CH.from(TestTable)
      .select(($) => ({ name: $.Id, count: CH.count() }))
      .groupBy("name")

    const union = unionAll(q1, q2)
      .orderBy(["count", "desc"])
      .limit(10)
      .format("JSON")

    const { sql } = compileUnion(union, {})
    expect(sql).toContain("SELECT * FROM (")
    expect(sql).toContain("UNION ALL")
    expect(sql).toContain("ORDER BY count DESC")
    expect(sql).toContain("LIMIT 10")
  })
})

// ---------------------------------------------------------------------------
// Subquery support
// ---------------------------------------------------------------------------

describe("subquery support", () => {
  const TestTable = CH.table("test_table", {
    Id: CH.string,
    Name: CH.string,
    Value: CH.uint64,
  })

  it("compiles inSubquery", () => {
    const innerSql = compileCH(
      CH.from(TestTable).select(($) => ({ id: $.Id })).where(($) => [$.Value.gt(100)]),
      {},
      { skipFormat: true },
    ).sql

    const outer = CH.from(TestTable)
      .select(($) => ({ name: $.Name }))
      .where(($) => [CH.inSubquery($.Id, innerSql)])
      .format("JSON")

    const { sql } = compileCH(outer, {})
    expect(sql).toContain("Id IN (SELECT")
    expect(sql).toContain("Value > 100")
  })

  it("compiles exists()", () => {
    const subSql = "SELECT 1 FROM other WHERE other.Id = test_table.Id"
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(() => [CH.exists(subSql)])
      .format("JSON")

    const { sql } = compileCH(q, {})
    expect(sql).toContain("EXISTS (SELECT 1 FROM other WHERE other.Id = test_table.Id)")
  })

  it("compiles fromQuery as typed FROM source", () => {
    const inner = CH.from(TestTable)
      .select(($) => ({ id: $.Id, name: $.Name }))
      .limit(10)

    const outer = CH.fromQuery(inner, "sub")
      .select(($) => ({
        id: $.id,
        name: $.name,
      }))
      .format("JSON")

    const { sql } = compileCH(outer, {})
    expect(sql).toContain("FROM (SELECT")
    expect(sql).toContain(") AS sub")
    expect(sql).toContain("LIMIT 10")
    expect(sql).toContain("id AS id")
    expect(sql).toContain("name AS name")
  })
})

// ---------------------------------------------------------------------------
// Type-safe joins
// ---------------------------------------------------------------------------

describe("type-safe joins", () => {
  const Users = CH.table("users", {
    Id: CH.string,
    Name: CH.string,
    OrgId: CH.string,
  })

  const Orders = CH.table("orders", {
    Id: CH.string,
    UserId: CH.string,
    Amount: CH.uint64,
    Status: CH.string,
  })

  it("compiles innerJoin with Table", () => {
    const q = CH.from(Users)
      .innerJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId))
      .select(($) => ({
        userName: $.Name,
        orderAmount: $.o.Amount,
      }))
      .format("JSON")

    const { sql } = compileCH(q, {})
    expect(sql).toContain("INNER JOIN orders AS o ON users.Id = o.UserId")
    expect(sql).toContain("users.Name AS userName")
    expect(sql).toContain("o.Amount AS orderAmount")
  })

  it("compiles leftJoin with Table", () => {
    const q = CH.from(Users)
      .leftJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId))
      .select(($) => ({
        userName: $.Name,
        orderAmount: $.o.Amount,
      }))
      .format("JSON")

    const { sql } = compileCH(q, {})
    expect(sql).toContain("LEFT JOIN orders AS o ON users.Id = o.UserId")
  })

  it("compiles crossJoin with Table", () => {
    const q = CH.from(Users)
      .crossJoin(Orders, "o")
      .select(($) => ({
        userName: $.Name,
        orderStatus: $.o.Status,
      }))
      .format("JSON")

    const { sql } = compileCH(q, {})
    expect(sql).toContain("CROSS JOIN orders AS o")
    expect(sql).not.toContain(" ON ")
  })

  it("compiles innerJoinQuery with subquery", () => {
    const ordersSub = CH.from(Orders)
      .select(($) => ({ userId: $.UserId, total: CH.sum($.Amount) }))
      .groupBy("userId")

    const q = CH.from(Users)
      .innerJoinQuery(ordersSub, "o", (u, o) => u.Id.eq(o.userId))
      .select(($) => ({
        userName: $.Name,
        orderTotal: $.o.total,
      }))
      .format("JSON")

    const { sql } = compileCH(q, {})
    expect(sql).toContain("INNER JOIN (SELECT")
    expect(sql).toContain(") AS o ON users.Id = o.userId")
    expect(sql).toContain("o.total AS orderTotal")
  })

  it("compiles crossJoinQuery with subquery", () => {
    const statsSub = CH.from(Orders)
      .select(() => ({ totalOrders: CH.count() }))

    const q = CH.from(Users)
      .crossJoinQuery(statsSub, "s")
      .select(($) => ({
        userName: $.Name,
        totalOrders: $.s.totalOrders,
      }))
      .format("JSON")

    const { sql } = compileCH(q, {})
    expect(sql).toContain("CROSS JOIN (SELECT")
    expect(sql).toContain(") AS s")
    expect(sql).toContain("s.totalOrders AS totalOrders")
  })

  it("compiles fromQuery + crossJoinQuery (two subqueries)", () => {
    const sub1 = CH.from(Users)
      .select(() => ({ userCount: CH.count() }))

    const sub2 = CH.from(Orders)
      .select(() => ({ orderCount: CH.count() }))

    const q = CH.fromQuery(sub1, "u")
      .crossJoinQuery(sub2, "o")
      .select(($) => ({
        users: $.userCount,
        orders: $.o.orderCount,
      }))
      .format("JSON")

    const { sql } = compileCH(q, {})
    expect(sql).toContain("FROM (SELECT")
    expect(sql).toContain(") AS u")
    expect(sql).toContain("CROSS JOIN (SELECT")
    expect(sql).toContain(") AS o")
    expect(sql).toContain("u.userCount AS users")
    expect(sql).toContain("o.orderCount AS orders")
  })

  it("compiles multiple chained joins", () => {
    const Tags = CH.table("tags", { Id: CH.string, UserId: CH.string, Label: CH.string })

    const q = CH.from(Users)
      .innerJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId))
      .innerJoin(Tags, "t", (u, t) => u.Id.eq(t.UserId))
      .select(($) => ({
        userName: $.Name,
        orderAmount: $.o.Amount,
        tag: $.t.Label,
      }))
      .format("JSON")

    const { sql } = compileCH(q, {})
    expect(sql).toContain("INNER JOIN orders AS o ON users.Id = o.UserId")
    expect(sql).toContain("INNER JOIN tags AS t ON users.Id = t.UserId")
    expect(sql).toContain("users.Name AS userName")
    expect(sql).toContain("o.Amount AS orderAmount")
    expect(sql).toContain("t.Label AS tag")
  })

  it("qualifies main table columns in where() with joins", () => {
    const q = CH.from(Users)
      .innerJoin(Orders, "o", (u, o) => u.Id.eq(o.UserId))
      .select(($) => ({ userName: $.Name }))
      .where(($) => [$.OrgId.eq("org_1")])
      .format("JSON")

    const { sql } = compileCH(q, {})
    expect(sql).toContain("users.OrgId = 'org_1'")
  })
})

// ---------------------------------------------------------------------------
// New expression functions
// ---------------------------------------------------------------------------

describe("new expression functions", () => {
  const TestTable = CH.table("test_table", {
    Id: CH.string,
    Name: CH.string,
    Value: CH.uint64,
    Attrs: CH.map(CH.string, CH.string),
  })

  it("compiles uniq()", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ unique: CH.uniq($.Name) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("uniq(Name) AS unique")
  })

  it("compiles sumIf()", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ total: CH.sumIf($.Value, $.Name.eq("test")) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("sumIf(Value, Name = 'test') AS total")
  })

  it("compiles toJSONString()", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ attrs: CH.toJSONString($.Attrs) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("toJSONString(Attrs) AS attrs")
  })

  it("compiles concat()", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ full: CH.concat($.Id, CH.lit(" "), $.Name) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("concat(Id, ' ', Name) AS full")
  })

  it("compiles round_()", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ rounded: CH.round_($.Value.div(100), 2) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("round(Value / 100, 2) AS rounded")
  })

  it("compiles intDiv()", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ result: CH.intDiv($.Value, 1000) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("intDiv(Value, 1000) AS result")
  })

  it("compiles ilike", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [$.Name.ilike("%test%")])
    const { sql } = compileCH(q, {})
    expect(sql).toContain("Name ILIKE '%test%'")
  })

  it("compiles groupUniqArray()", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ names: CH.groupUniqArray($.Name) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("groupUniqArray(Name) AS names")
  })

  it("generalized min_/max_ accepts string columns", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ first: CH.min($.Name), last: CH.max($.Name) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("min(Name) AS first")
    expect(sql).toContain("max(Name) AS last")
  })

  it("generalized any_() accepts any column", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ sample: CH.any($.Name) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("any(Name) AS sample")
  })
})

// ---------------------------------------------------------------------------
// Converted queries — smoke tests
// ---------------------------------------------------------------------------

describe("converted queries", () => {
  const baseParams = { orgId: "org_1", startTime: "2024-01-01", endTime: "2024-01-02" }

  it("logsFacetsQuery compiles UNION ALL", () => {
    const q = logsFacetsQuery({})
    const { sql } = compileUnion(q, baseParams)
    expect(sql).toContain("UNION ALL")
    expect(sql).toContain("'severity' AS facetType")
    expect(sql).toContain("'service' AS facetType")
    expect(sql).toContain("ORDER BY count DESC")
  })

  it("servicesFacetsQuery compiles UNION ALL", () => {
    const q = servicesFacetsQuery()
    const { sql } = compileUnion(q, baseParams)
    expect(sql).toContain("UNION ALL")
    expect(sql).toContain("'environment' AS facetType")
    expect(sql).toContain("'commit_sha' AS facetType")
  })

  it("metricsSummaryQuery compiles 4 UNION ALL", () => {
    const q = metricsSummaryQuery()
    const { sql } = compileUnion(q, baseParams)
    const unionCount = (sql.match(/UNION ALL/g) || []).length
    expect(unionCount).toBe(3) // 4 queries = 3 UNION ALL
    expect(sql).toContain("'sum' AS metricType")
    expect(sql).toContain("'gauge' AS metricType")
    expect(sql).toContain("uniq(MetricName)")
  })

  it("spanAttributeValuesQuery compiles with map access", () => {
    const q = spanAttributeValuesQuery({ attributeKey: "http.method" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("SpanAttributes['http.method'] AS attributeValue")
    expect(sql).toContain("SpanAttributes['http.method'] != ''")
    expect(sql).toContain("ORDER BY usageCount DESC")
  })

  it("resourceAttributeValuesQuery compiles with map access", () => {
    const q = resourceAttributeValuesQuery({ attributeKey: "host.name" })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("ResourceAttributes['host.name'] AS attributeValue")
  })

  it("tracesDurationStatsQuery compiles with positionCaseInsensitive", () => {
    const q = tracesDurationStatsQuery({
      serviceName: "api",
      matchModes: { serviceName: "contains" },
    })
    const { sql } = compileCH(q, baseParams)
    expect(sql).toContain("positionCaseInsensitive(ServiceName, 'api') > 0")
    expect(sql).toContain("quantile(0.5)(Duration)")
    expect(sql).toContain("FROM trace_list_mv") // tracesDurationStats always uses MV directly
  })

  it("spanHierarchyQuery compiles with toJSONString", () => {
    const q = spanHierarchyQuery({ traceId: "abc123" })
    const { sql } = compileCH(q, { orgId: "org_1" })
    expect(sql).toContain("toJSONString(SpanAttributes) AS spanAttributes")
    expect(sql).toContain("toJSONString(ResourceAttributes) AS resourceAttributes")
    expect(sql).toContain("TraceId = 'abc123'")
    expect(sql).toContain("'related' AS relationship")
  })

  it("spanHierarchyQuery with spanId marks target", () => {
    const q = spanHierarchyQuery({ traceId: "abc", spanId: "span1" })
    const { sql } = compileCH(q, { orgId: "org_1" })
    expect(sql).toContain("'target'")
    expect(sql).toContain("'related'")
  })
})
