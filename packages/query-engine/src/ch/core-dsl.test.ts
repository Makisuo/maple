import { describe, expect, it } from "bun:test"
import * as CH from "./index"
import { compileCH, QueryBuilderError } from "./compile"

const TestTable = CH.table("test_table", {
  Id: CH.string,
  Name: CH.string,
  Value: CH.uint64,
  Attrs: CH.map(CH.string, CH.string),
  Timestamp: CH.dateTime64,
  Active: CH.uint8,
})

// ---------------------------------------------------------------------------
// Untested expression functions
// ---------------------------------------------------------------------------

describe("expression functions", () => {
  it("compiles coalesce", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ result: CH.coalesce(CH.nullIf($.Name, ""), CH.lit("default")) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("coalesce(nullIf(Name, ''), 'default') AS result")
  })

  it("compiles nullIf", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ result: CH.nullIf($.Name, "") }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("nullIf(Name, '') AS result")
  })

  it("compiles multiIf", () => {
    const q = CH.from(TestTable)
      .select(($) => ({
        result: CH.multiIf(
          [
            [$.Value.gt(100), CH.lit("high")],
            [$.Value.gt(50), CH.lit("medium")],
          ],
          CH.lit("low"),
        ),
      }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("multiIf(Value > 100, 'high', Value > 50, 'medium', 'low') AS result")
  })

  it("compiles mapContains", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [CH.mapContains($.Attrs, "http.method")])
    const { sql } = compileCH(q, {})
    expect(sql).toContain("mapContains(Attrs, 'http.method')")
  })

  it("compiles mapGet", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ method: CH.mapGet($.Attrs, "http.method") }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("Attrs['http.method'] AS method")
  })

  it("compiles mapLiteral", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ m: CH.mapLiteral(["key1", $.Name], ["key2", CH.lit("val")]) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("map('key1', Name, 'key2', 'val') AS m")
  })

  it("compiles empty mapLiteral", () => {
    const q = CH.from(TestTable)
      .select(() => ({ m: CH.mapLiteral() }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("map() AS m")
  })

  it("compiles position_", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ pos: CH.position($.Name, "foo") }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("position(Name, 'foo') AS pos")
  })

  it("compiles left_ and length_", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ result: CH.left($.Name, CH.length($.Name)) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("left(Name, length(Name)) AS result")
  })

  it("compiles replaceOne", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ result: CH.replaceOne($.Name, "old", "new") }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("replaceOne(Name, 'old', 'new') AS result")
  })

  it("compiles toFloat64OrZero", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ num: CH.toFloat64OrZero($.Name) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("toFloat64OrZero(Name) AS num")
  })

  it("compiles toString_", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ s: CH.toString($.Value) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("toString(Value) AS s")
  })

  it("compiles intervalSub", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ ts: CH.intervalSub($.Timestamp, 3600) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("Timestamp - INTERVAL 3600 SECOND AS ts")
  })

  it("compiles outerRef", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(() => [CH.outerRef("t.TraceId").eq("abc")])
    const { sql } = compileCH(q, {})
    expect(sql).toContain("t.TraceId = 'abc'")
  })

  it("compiles rawCond", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(() => [CH.rawCond("x = 1")])
    const { sql } = compileCH(q, {})
    expect(sql).toContain("x = 1")
  })

  it("compiles notLike", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [$.Name.notLike("%test%")])
    const { sql } = compileCH(q, {})
    expect(sql).toContain("Name NOT LIKE '%test%'")
  })

  it("compiles notIn", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [$.Name.notIn("a", "b")])
    const { sql } = compileCH(q, {})
    expect(sql).toContain("Name NOT IN ('a', 'b')")
  })

  it("compiles least_ and greatest_", () => {
    const q = CH.from(TestTable)
      .select(($) => ({
        lo: CH.least($.Value, CH.lit(100)),
        hi: CH.greatest($.Value, CH.lit(0)),
      }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("least(Value, 100) AS lo")
    expect(sql).toContain("greatest(Value, 0) AS hi")
  })

  it("compiles toUInt64 and toInt64", () => {
    const q = CH.from(TestTable)
      .select(($) => ({
        u: CH.toUInt64($.Value),
        i: CH.toInt64($.Value),
      }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("toUInt64(Value) AS u")
    expect(sql).toContain("toInt64(Value) AS i")
  })

  it("compiles positionCaseInsensitive", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ pos: CH.positionCaseInsensitive($.Name, CH.lit("foo")) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("positionCaseInsensitive(Name, 'foo') AS pos")
  })

  it("compiles extract_", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ result: CH.extract($.Name, "th:([0-9]+)") }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("extract(Name, 'th:([0-9]+)') AS result")
  })

  it("compiles arrayFilter", () => {
    const arr = CH.arrayOf(CH.lit("a"), CH.lit(""), CH.lit("b"))
    const q = CH.from(TestTable)
      .select(() => ({ result: CH.arrayFilter("x -> x != ''", arr) }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("arrayFilter(x -> x != '', ['a', '', 'b']) AS result")
  })

  it("compiles arrayStringConcat with Expr array", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ result: CH.arrayStringConcat(CH.arrayOf($.Name, CH.lit("x")), " | ") }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("arrayStringConcat([Name, 'x'], ' | ') AS result")
  })
})

// ---------------------------------------------------------------------------
// Condition combinators
// ---------------------------------------------------------------------------

describe("condition combinators", () => {
  it("and() combines conditions", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [$.Name.eq("alice").and($.Value.gt(10))])
    const { sql } = compileCH(q, {})
    expect(sql).toContain("(Name = 'alice' AND Value > 10)")
  })

  it("or() combines conditions", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [$.Name.eq("alice").or($.Name.eq("bob"))])
    const { sql } = compileCH(q, {})
    expect(sql).toContain("(Name = 'alice' OR Name = 'bob')")
  })

  it("chains and/or", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [
        $.Name.eq("alice").or($.Name.eq("bob")).and($.Value.gt(0)),
      ])
    const { sql } = compileCH(q, {})
    expect(sql).toContain("((Name = 'alice' OR Name = 'bob') AND Value > 0)")
  })
})

// ---------------------------------------------------------------------------
// Compile edge cases
// ---------------------------------------------------------------------------

describe("compile edge cases", () => {
  it("throws QueryBuilderError when no select", () => {
    const q = CH.from(TestTable).format("JSON")
    expect(() => compileCH(q, {})).toThrow()
  })

  it("compiles CTE with withCTE", () => {
    const q = CH.from(TestTable)
      .withCTE("my_cte", "SELECT 1 AS x")
      .select(($) => ({ id: $.Id }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("WITH my_cte AS")
    expect(sql).toContain("SELECT 1 AS x")
  })

  it("compiles INNER JOIN", () => {
    const OtherTable = CH.table("other_table", { Id: CH.string, Score: CH.uint64 })
    const q = CH.from(TestTable)
      .innerJoin(OtherTable, "o", (main, o) => main.Id.eq(o.Id))
      .select(($) => ({ id: $.Id, score: $.o.Score }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("INNER JOIN other_table AS o ON test_table.Id = o.Id")
    expect(sql).toContain("o.Score AS score")
  })

  it("compiles CROSS JOIN (no ON clause)", () => {
    const OtherTable = CH.table("other_table", { Id: CH.string, Score: CH.uint64 })
    const q = CH.from(TestTable)
      .crossJoin(OtherTable, "o")
      .select(($) => ({ id: $.Id, score: $.o.Score }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("CROSS JOIN other_table AS o")
    expect(sql).not.toContain(" ON ")
  })

  it("compiles table alias", () => {
    const q = CH.from(TestTable, "t")
      .select(($) => ({ id: $.Id }))
    const { sql } = compileCH(q, {})
    expect(sql).toContain("FROM test_table AS t")
  })

  it("compiles OFFSET", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .limit(10)
      .offset(5)
    const { sql } = compileCH(q, {})
    expect(sql).toContain("LIMIT 10")
    expect(sql).toContain("OFFSET 5")
  })
})

// ---------------------------------------------------------------------------
// Param resolution
// ---------------------------------------------------------------------------

describe("param resolution", () => {
  it("resolves param.string", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [$.Id.eq(CH.param.string("orgId"))])
    const { sql } = compileCH(q, { orgId: "org_123" })
    expect(sql).toContain("Id = 'org_123'")
  })

  it("resolves param.int", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [$.Value.gt(CH.param.int("threshold"))])
    const { sql } = compileCH(q, { threshold: 42 })
    expect(sql).toContain("Value > 42")
  })

  it("resolves param.dateTime", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [$.Timestamp.gte(CH.param.dateTime("startTime"))])
    const { sql } = compileCH(q, { startTime: "2024-01-01 00:00:00" })
    expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00'")
  })

  it("resolves boolean param", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [$.Active.eq(CH.param.int("isActive"))])
    const { sql } = compileCH(q, { isActive: true })
    expect(sql).toContain("Active = 1")
  })

  it("leaves unresolved param placeholders", () => {
    const q = CH.from(TestTable)
      .select(($) => ({ id: $.Id }))
      .where(($) => [$.Id.eq(CH.param.string("orgId"))])
    const { sql } = compileCH(q, {})
    expect(sql).toContain("__PARAM_orgId__")
  })
})
