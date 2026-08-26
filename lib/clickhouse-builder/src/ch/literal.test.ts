import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Schema } from "effect"
import * as CH from "./index"
import * as T from "./types"
import { compileCHUnsafe } from "./compile"
import { encodeLiteral, sqlLiteral } from "./literal"

// A column type is a codec, so the value that comes back out of a row and the
// literal that goes into the SQL are the same schema read in two directions.
// These pin that both directions agree, per type — a union's *encode* picks the
// first matching member, which is not something to assume.

const Events = CH.table("events", {
	OrgId: T.string,
	Live: T.bool,
	Count: T.uint64,
	Ratio: T.float64,
	Timestamp: T.dateTime,
	Attributes: T.map(T.string, T.string),
	Tags: T.array(T.string),
	Note: T.nullable(T.string),
})

const whereSql = (
	build: Parameters<ReturnType<typeof CH.from<"events", typeof Events.columns>>["where"]>[0],
) =>
	compileCHUnsafe(
		CH.from(Events)
			.select(($) => ({ id: $.OrgId }))
			.where(build),
		{},
	)
		.sql.split("WHERE")[1]
		?.trim()

describe("literals encode through the column's type", () => {
	it("writes a Map as ClickHouse's map() rather than [object Object]", () => {
		expect(whereSql(($) => [$.Attributes.eq({ "http.method": "GET" })])).toBe(
			"Attributes = map('http.method', 'GET')",
		)
	})

	it("writes an Array with brackets and quoted elements", () => {
		expect(whereSql(($) => [$.Tags.eq(["a", "b"])])).toBe("Tags = ['a', 'b']")
		expect(whereSql(($) => [$.Tags.in_(["a"], ["b"])])).toBe("Tags IN (['a'], ['b'])")
	})

	it("writes a Bool as 1/0, which is what ClickHouse compares against", () => {
		expect(whereSql(($) => [$.Live.eq(true)])).toBe("Live = 1")
		expect(whereSql(($) => [$.Live.eq(false)])).toBe("Live = 0")
	})

	it("writes null as NULL", () => {
		expect(whereSql(($) => [$.Note.eq(null)])).toBe("Note = NULL")
	})

	it("escapes strings", () => {
		expect(whereSql(($) => [$.OrgId.eq("a'b\\c")])).toBe("OrgId = 'a\\'b\\\\c'")
	})

	it("accepts every shape a DateTime comparison is typed to take", () => {
		const expected = "Timestamp >= '2026-01-01 00:00:00'"
		expect(whereSql(($) => [$.Timestamp.gte("2026-01-01 00:00:00")])).toBe(expected)
		expect(whereSql(($) => [$.Timestamp.gte(new Date("2026-01-01T00:00:00Z"))])).toBe(expected)
		expect(whereSql(($) => [$.Timestamp.gte(DateTime.makeUnsafe("2026-01-01T00:00:00Z"))])).toBe(expected)
	})

	// The types already reject these; the guard is for values that arrive from
	// outside the type system — a decoded request body, a JSON config.
	const compareUnchecked = (column: "Count" | "OrgId", value: unknown) =>
		whereSql(($) => {
			// SAFETY: deliberately bypassing the static check to exercise the runtime
			// one. `eq` accepts any value at runtime; the codec is what refuses it.
			const ref = $[column] as CH.Expr<never>
			return [ref.eq(value as never)]
		})

	it("refuses a value the column cannot hold", () => {
		expect(() => compareUnchecked("Count", "lots")).toThrow(/column Count.*Expected number/s)
		expect(() => compareUnchecked("OrgId", undefined)).toThrow(/column OrgId.*undefined/s)
	})
})

describe("decode and encode agree", () => {
	// One value per type, sent through the column's schema in both directions.
	const cases: ReadonlyArray<readonly [string, CH.CHType<string, any, any>, unknown, string]> = [
		["string", T.string, "checkout", "'checkout'"],
		["uint64", T.uint64, 42, "42"],
		["float64", T.float64, 0.95, "0.95"],
		["bool", T.bool, true, "1"],
		["array", T.array(T.string), ["a"], "['a']"],
		["map", T.map(T.string, T.string), { a: "b" }, "map('a', 'b')"],
		["nullable", T.nullable(T.string), null, "NULL"],
	]

	for (const [name, type, value, literal] of cases) {
		it.effect(`${name} round-trips`, () =>
			Effect.gen(function* () {
				expect(encodeLiteral(type.literalSchema, value, name)).toBe(literal)
				// And the wire form it encodes to decodes back to the same value.
				const wire = Schema.encodeUnknownSync(type.schema)(value)
				expect(yield* Schema.decodeUnknownEffect(type.schema)(wire)).toEqual(value)
			}),
		)
	}

	it.effect("dateTime round-trips through ClickHouse's tz-less shape", () =>
		Effect.gen(function* () {
			const value = DateTime.makeUnsafe("2026-01-01T12:30:00Z")
			expect(encodeLiteral(T.dateTime.literalSchema, value, "ts")).toBe("'2026-01-01 12:30:00'")
			expect(yield* Schema.decodeUnknownEffect(T.dateTime.schema)("2026-01-01 12:30:00")).toEqual(value)
		}),
	)
})

describe("sqlLiteral", () => {
	it("nests arrays and maps", () => {
		expect(sqlLiteral([{ a: "b" }, { c: "d" }], "test")).toBe("[map('a', 'b'), map('c', 'd')]")
	})

	it("refuses what has no ClickHouse literal", () => {
		expect(() => sqlLiteral(Number.NaN, "test")).toThrow(/no ClickHouse literal/)
		expect(() => sqlLiteral(undefined, "test")).toThrow(/cannot write undefined/)
		expect(() => sqlLiteral(() => 1, "test")).toThrow(/cannot write a function/)
	})
})

describe("param.of", () => {
	it("resolves a param of a custom column type", () => {
		const Level = T.custom("Enum8", Schema.Literals(["warn", "error"]))
		const query = CH.from(Events)
			.select(($) => ({ id: $.OrgId }))
			.where(($) => [$.OrgId.eq(CH.param.of(Level, "level"))])

		expect(compileCHUnsafe(query, { level: "warn" }).sql).toContain("OrgId = 'warn'")
	})
})
