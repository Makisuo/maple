import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import * as CH from "./index"
import { compileCHUnsafe } from "./compile"

const TestTable = CH.table("test_table", {
	Id: CH.string,
	Name: CH.string,
	Value: CH.uint64,
	Attrs: CH.map(CH.string, CH.string),
	Timestamp: CH.dateTime64,
	Active: CH.uint8,
	Live: CH.bool,
})

// Untested expression functions

describe("expression functions", () => {
	it("compiles coalesce", () => {
		const q = CH.from(TestTable).select(($) => ({
			result: CH.coalesce(CH.nullIf($.Name, ""), CH.lit("default")),
		}))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("coalesce(nullIf(Name, ''), 'default') AS result")
	})

	// `coalesce(nullIf(x, ''), y)` is a `String` to ClickHouse, not a
	// `Nullable(String)`: one non-nullable argument means the call can always
	// supply a value. Deriving it as nullable is what forced the queries using
	// this shape to hand-declare a row schema that narrowed it back.
	it("derives coalesce as non-nullable when one argument is", () => {
		const q = CH.from(TestTable).select(($) => ({
			result: CH.coalesce(CH.nullIf($.Name, ""), $.Attrs.get("fallback")),
		}))
		const compiled = compileCHUnsafe(q, {})
		expect(compiled.rowSchemaSource).toBe("derived")
		expect(Effect.runSync(compiled.decodeRows([{ result: "kept" }]))).toEqual([{ result: "kept" }])
		expect(Effect.runSync(Effect.exit(compiled.decodeRows([{ result: null }])))._tag).toBe("Failure")
	})

	it("derives coalesce as nullable when every argument is", () => {
		const q = CH.from(TestTable).select(($) => ({
			result: CH.coalesce(CH.nullIf($.Name, ""), CH.nullIf($.Name, "x")),
		}))
		const compiled = compileCHUnsafe(q, {})
		expect(Effect.runSync(compiled.decodeRows([{ result: null }]))).toEqual([{ result: null }])
	})

	it("compiles nullIf", () => {
		const q = CH.from(TestTable).select(($) => ({ result: CH.nullIf($.Name, "") }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("nullIf(Name, '') AS result")
	})

	it("compiles multiIf", () => {
		const q = CH.from(TestTable).select(($) => ({
			result: CH.multiIf(
				[
					[$.Value.gt(100), CH.lit("high")],
					[$.Value.gt(50), CH.lit("medium")],
				],
				CH.lit("low"),
			),
		}))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("multiIf(Value > 100, 'high', Value > 50, 'medium', 'low') AS result")
	})

	it("compiles mapContains", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [CH.mapContains($.Attrs, "http.method")])
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("mapContains(Attrs, 'http.method')")
	})

	it("compiles mapGet", () => {
		const q = CH.from(TestTable).select(($) => ({ method: CH.mapGet($.Attrs, "http.method") }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("Attrs['http.method'] AS method")
	})

	it("compiles mapLiteral", () => {
		const q = CH.from(TestTable).select(($) => ({
			m: CH.mapLiteral(["key1", $.Name], ["key2", CH.lit("val")]),
		}))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("map('key1', Name, 'key2', 'val') AS m")
	})

	it("compiles mapFilterKeys with the DSL's own conditions on the key", () => {
		const q = CH.from(TestTable).select(($) => ({
			m: CH.mapFilterKeys($.Attrs, (k) => k.in_("a", "b").or(k.like("x.%"))),
		}))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("mapFilter((k, v) -> (k IN ('a', 'b') OR k LIKE 'x.%'), Attrs) AS m")
	})

	it("compiles empty mapLiteral", () => {
		const q = CH.from(TestTable).select(() => ({ m: CH.mapLiteral() }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("map() AS m")
	})

	it("compiles position_", () => {
		const q = CH.from(TestTable).select(($) => ({ pos: CH.position($.Name, "foo") }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("position(Name, 'foo') AS pos")
	})

	it("compiles left_ and length_", () => {
		const q = CH.from(TestTable).select(($) => ({ result: CH.left($.Name, CH.length($.Name)) }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("left(Name, length(Name)) AS result")
	})

	it("compiles replaceOne", () => {
		const q = CH.from(TestTable).select(($) => ({ result: CH.replaceOne($.Name, "old", "new") }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("replaceOne(Name, 'old', 'new') AS result")
	})

	it("compiles toFloat64OrZero", () => {
		const q = CH.from(TestTable).select(($) => ({ num: CH.toFloat64OrZero($.Name) }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("toFloat64OrZero(Name) AS num")
	})

	it("compiles toString_", () => {
		const q = CH.from(TestTable).select(($) => ({ s: CH.toString($.Value) }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("toString(Value) AS s")
	})

	it("compiles intervalSub", () => {
		const q = CH.from(TestTable).select(($) => ({ ts: CH.intervalSub($.Timestamp, 3600) }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("Timestamp - INTERVAL 3600 SECOND AS ts")
	})

	it("compiles intervalAdd", () => {
		const q = CH.from(TestTable).select(($) => ({ ts: CH.intervalAdd($.Timestamp, 3600) }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("Timestamp + INTERVAL 3600 SECOND AS ts")
	})

	it("compiles outerRef", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(() => [CH.outerRef("t.TraceId").eq("abc")])
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("t.TraceId = 'abc'")
	})

	it("compiles rawCond", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(() => [CH.rawCond("x = 1")])
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("x = 1")
	})

	it("compiles notLike", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Name.notLike("%test%")])
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("Name NOT LIKE '%test%'")
	})

	it("compiles notIn", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Name.notIn("a", "b")])
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("Name NOT IN ('a', 'b')")
	})

	it("compiles least_ and greatest_", () => {
		const q = CH.from(TestTable).select(($) => ({
			lo: CH.least($.Value, CH.lit(100)),
			hi: CH.greatest($.Value, CH.lit(0)),
		}))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("least(Value, 100) AS lo")
		expect(sql).toContain("greatest(Value, 0) AS hi")
	})

	it("compiles toUInt64 and toInt64", () => {
		const q = CH.from(TestTable).select(($) => ({
			u: CH.toUInt64($.Value),
			i: CH.toInt64($.Value),
		}))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("toUInt64(Value) AS u")
		expect(sql).toContain("toInt64(Value) AS i")
	})

	it("compiles positionCaseInsensitive", () => {
		const q = CH.from(TestTable).select(($) => ({
			pos: CH.positionCaseInsensitive($.Name, CH.lit("foo")),
		}))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("positionCaseInsensitive(Name, 'foo') AS pos")
	})

	it("compiles extract_", () => {
		const q = CH.from(TestTable).select(($) => ({ result: CH.extract($.Name, "th:([0-9]+)") }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("extract(Name, 'th:([0-9]+)') AS result")
	})

	it("compiles arrayFilter", () => {
		const arr = CH.arrayOf(CH.lit("a"), CH.lit(""), CH.lit("b"))
		const q = CH.from(TestTable).select(() => ({ result: CH.arrayFilter("x -> x != ''", arr) }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("arrayFilter(x -> x != '', ['a', '', 'b']) AS result")
	})

	it("compiles arrayJoin", () => {
		const arr = CH.arrayOf(CH.lit("a"), CH.lit("b"))
		const q = CH.from(TestTable).select(() => ({ result: CH.arrayJoin(arr) }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("arrayJoin(['a', 'b']) AS result")
	})

	it("compiles arrayStringConcat with Expr array", () => {
		const q = CH.from(TestTable).select(($) => ({
			result: CH.arrayStringConcat(CH.arrayOf($.Name, CH.lit("x")), " | "),
		}))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("arrayStringConcat([Name, 'x'], ' | ') AS result")
	})
})

// Parametric aggregates

describe("parametric aggregates", () => {
	it("compiles windowFunnel with the window as a parameter and the conditions as arguments", () => {
		const q = CH.from(TestTable)
			.select(($) => ({
				id: $.Id,
				level: CH.windowFunnel(3600)($.Timestamp, $.Name.eq("a"), $.Name.eq("b"), $.Value.gt(1)),
			}))
			.groupBy("id")
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("windowFunnel(3600)(Timestamp, Name = 'a', Name = 'b', Value > 1) AS level")
	})

	it("compiles windowFunnel with a mode", () => {
		const q = CH.from(TestTable).select(($) => ({
			level: CH.windowFunnel(86400, "strict_order")($.Timestamp, $.Name.eq("a"), $.Name.eq("b")),
		}))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain(
			"windowFunnel(86400, 'strict_order')(Timestamp, Name = 'a', Name = 'b') AS level",
		)
	})

	it("windowFunnel refuses an empty condition list", () => {
		const q = CH.from(TestTable).select(($) => ({ level: CH.windowFunnel(60)($.Timestamp) }))
		expect(() => compileCHUnsafe(q, {})).toThrow(/at least one condition/)
	})

	it("compiles sequenceMatch with the pattern as a parameter", () => {
		const q = CH.from(TestTable).select(($) => ({
			matched: CH.sequenceMatch("(?1)(?t<3600)(?2)")($.Timestamp, $.Name.eq("a"), $.Name.eq("b")),
		}))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain(
			"sequenceMatch('(?1)(?t<3600)(?2)')(Timestamp, Name = 'a', Name = 'b') AS matched",
		)
	})

	// Checked when the aggregate is applied, not when the factory is called, so a
	// hoisted `const matcher = sequenceMatch(p)` fails inside the compile that
	// uses it rather than at module scope where nothing can catch it.
	it("sequenceMatch refuses a pattern that could break out of the literal", () => {
		const matcher = CH.sequenceMatch("(?1)'; DROP")
		expect(() => matcher(CH.dynamicColumn("Timestamp"), CH.rawCond("1"))).toThrow(/quotes/)

		const query = CH.from(TestTable)
			.select(($) => ({ matched: CH.sequenceMatch("(?1)'; DROP")($.Timestamp, $.Name.eq("a")) }))
			.where(($) => [$.Id.eq("id_1")])
		const error = Effect.runSync(Effect.flip(CH.compile(query, {})))
		expect(error.code).toBe("InvalidArguments")
	})
})

// Condition combinators

describe("condition combinators", () => {
	it("and() combines conditions", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Name.eq("alice").and($.Value.gt(10))])
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("(Name = 'alice' AND Value > 10)")
	})

	it("or() combines conditions", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Name.eq("alice").or($.Name.eq("bob"))])
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("(Name = 'alice' OR Name = 'bob')")
	})

	it("chains and/or", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Name.eq("alice").or($.Name.eq("bob")).and($.Value.gt(0))])
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("((Name = 'alice' OR Name = 'bob') AND Value > 0)")
	})
})

// Compile edge cases

describe("compile edge cases", () => {
	it("throws QueryBuilderError when no select", () => {
		const q = CH.from(TestTable).format("JSON")
		expect(() => compileCHUnsafe(q, {})).toThrow()
	})

	// `.orderBy("id", "desc")` instead of `.orderBy(["id", "desc"])` is the
	// natural slip. TypeScript rejects it, but untyped callers used to get
	// `ORDER BY i D` — a string destructures into its first two characters.
	it("throws QueryBuilderError on a non-tuple orderBy spec", () => {
		const q = CH.from(TestTable).select(($) => ({ id: $.Id }))
		const bad = (q as any).orderBy("id", "desc")
		expect(() => compileCHUnsafe(bad, {})).toThrow(/orderBy\(\) takes \[column, direction\] tuples/)
	})

	it("throws QueryBuilderError on an unknown orderBy direction", () => {
		const q = CH.from(TestTable).select(($) => ({ id: $.Id }))
		const bad = (q as any).orderBy(["id", "descending"])
		expect(() => compileCHUnsafe(bad, {})).toThrow(/direction must be "asc" or "desc"/)
	})

	it("compiles CTE with withCTE", () => {
		const q = CH.from(TestTable)
			.withCTE("my_cte", "SELECT 1 AS x")
			.select(($) => ({ id: $.Id }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("WITH my_cte AS")
		expect(sql).toContain("SELECT 1 AS x")
	})

	it("compiles INNER JOIN", () => {
		const OtherTable = CH.table("other_table", { Id: CH.string, Score: CH.uint64 })
		const q = CH.from(TestTable)
			.innerJoin(OtherTable, "o", (main, o) => main.Id.eq(o.Id))
			.select(($) => ({ id: $.Id, score: $.o.Score }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("INNER JOIN other_table AS o ON test_table.Id = o.Id")
		expect(sql).toContain("o.Score AS score")
	})

	it("compiles CROSS JOIN (no ON clause)", () => {
		const OtherTable = CH.table("other_table", { Id: CH.string, Score: CH.uint64 })
		const q = CH.from(TestTable)
			.crossJoin(OtherTable, "o")
			.select(($) => ({ id: $.Id, score: $.o.Score }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("CROSS JOIN other_table AS o")
		expect(sql).not.toContain(" ON ")
	})

	it("compiles table alias", () => {
		const q = CH.from(TestTable, "t").select(($) => ({ id: $.Id }))
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("FROM test_table AS t")
	})

	it("compiles OFFSET", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.limit(10)
			.offset(5)
		const { sql } = compileCHUnsafe(q, {})
		expect(sql).toContain("LIMIT 10")
		expect(sql).toContain("OFFSET 5")
	})
})

// Param resolution

describe("param resolution", () => {
	it("resolves param.string", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Id.eq(CH.param.string("orgId"))])
		const { sql } = compileCHUnsafe(q, { orgId: "org_123" })
		expect(sql).toContain("Id = 'org_123'")
	})

	it("resolves param.int", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Value.gt(CH.param.int("threshold"))])
		const { sql } = compileCHUnsafe(q, { threshold: 42 })
		expect(sql).toContain("Value > 42")
	})

	it("resolves param.dateTime", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Timestamp.gte(CH.param.dateTime("startTime"))])
		const { sql } = compileCHUnsafe(q, { startTime: "2024-01-01 00:00:00" })
		expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00'")
	})

	it("resolves boolean param", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Live.eq(CH.param.bool("isActive"))])
		const { sql } = compileCHUnsafe(q, { isActive: true })
		expect(sql).toContain("Live = 1")
	})

	it("resolves a fractional param", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Value.gt(CH.param.float("threshold"))])
		const { sql } = compileCHUnsafe(q, { threshold: 0.95 })
		expect(sql).toContain("Value > 0.95")
	})

	it("formats a Date passed to a dateTime param", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Timestamp.gte(CH.param.dateTime("since"))])
		const { sql } = compileCHUnsafe(q, { since: new Date("2026-01-01T00:00:00Z") })
		expect(sql).toContain("Timestamp >= '2026-01-01 00:00:00'")
	})

	it("ignores params the query never mentions", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Id.eq(CH.param.string("id"))])
		const { sql } = compileCHUnsafe(q, { id: "a", unrelated: "b" })
		expect(sql).toContain("Id = 'a'")
	})

	// A param that never arrives used to ship `__PARAM_x__` to the server, and a
	// wrongly-typed one used to stringify into the SQL text. Both fail loudly now.

	it("rejects a param with no value", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Id.eq(CH.param.string("orgId"))])
		expect(() => compileCHUnsafe(q, {})).toThrow(/no value given for param 'orgId'/)
	})

	it("rejects a value of the wrong type", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Id.eq(CH.param.string("orgId"))])
		expect(() => compileCHUnsafe(q, { orgId: 42 })).toThrow(/param 'orgId' \(string\).*Expected string/)
	})

	it("rejects a fraction where an integer was declared", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Value.eq(CH.param.int("bucketSeconds"))])
		expect(() => compileCHUnsafe(q, { bucketSeconds: 1.5 })).toThrow(/param.float/)
	})

	it("rejects an undefined value", () => {
		const q = CH.from(TestTable)
			.select(($) => ({ id: $.Id }))
			.where(($) => [$.Id.eq(CH.param.string("orgId"))])
		expect(() => compileCHUnsafe(q, { orgId: undefined })).toThrow(/undefined is not a valid value/)
	})

	it("rejects a param name that cannot round-trip through the placeholder", () => {
		expect(() => CH.param.string("org__id")).toThrow(/alphanumeric/)
	})
})
