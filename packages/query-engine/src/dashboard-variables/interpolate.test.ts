import { describe, expect, it } from "vitest"

import {
	ALL_VALUE,
	collectVariableRefs,
	hasUnresolvedVariableRefs,
	interpolateDisplayText,
	interpolateWidgetParams,
	type VariableValues,
} from "./interpolate"

const single = (value: string): VariableValues[string] => ({ value, isAll: false, options: [] })
const all = (options: string[]): VariableValues[string] => ({
	value: ALL_VALUE,
	isAll: true,
	options,
})

describe("collectVariableRefs", () => {
	it("collects bare and braced references", () => {
		expect(collectVariableRefs('service.name = "$service" AND env = "${env}"')).toEqual([
			"service",
			"env",
		])
	})

	it("never matches built-in $__ macros", () => {
		expect(collectVariableRefs("WHERE $__orgFilter AND $__timeFilter(Timestamp)")).toEqual([])
	})

	it("dedupes repeated references", () => {
		expect(collectVariableRefs("$a + $a + ${a}")).toEqual(["a"])
	})
})

describe("interpolateWidgetParams — plain strings", () => {
	it("substitutes values in plain params", () => {
		const result = interpolateWidgetParams({ service_name: "$service" }, { service: single("api") })
		expect(result).toEqual({ service_name: "api" })
	})

	it("substitutes braced references adjacent to text", () => {
		const result = interpolateWidgetParams({ title: "svc-${env}-suffix" }, { env: single("prod") })
		expect(result).toEqual({ title: "svc-prod-suffix" })
	})

	it("leaves unknown references literal", () => {
		const result = interpolateWidgetParams({ service_name: "$ghost" }, { service: single("api") })
		expect(result).toEqual({ service_name: "$ghost" })
	})

	it("leaves $__startTime/$__endTime untouched", () => {
		const result = interpolateWidgetParams(
			{ startTime: "$__startTime", endTime: "$__endTime" },
			{ service: single("api") },
		)
		expect(result).toEqual({ startTime: "$__startTime", endTime: "$__endTime" })
	})

	it("recurses through nested objects and arrays", () => {
		const result = interpolateWidgetParams(
			{
				queries: [{ label: "$service", nested: { deep: "${service}" } }],
				plain: 42,
				flag: true,
			},
			{ service: single("api") },
		)
		expect(result).toEqual({
			queries: [{ label: "api", nested: { deep: "api" } }],
			plain: 42,
			flag: true,
		})
	})

	it("joins All selections with commas in plain params", () => {
		const result = interpolateWidgetParams({ service_name: "$service" }, { service: all(["a", "b"]) })
		expect(result).toEqual({ service_name: "a,b" })
	})
})

describe("interpolateWidgetParams — sql", () => {
	it("substitutes quoted escaped literals in sql params", () => {
		const result = interpolateWidgetParams(
			{ sql: "SELECT 1 WHERE $__orgFilter AND ServiceName IN ($service)" },
			{ service: single("api") },
		)
		expect(result).toEqual({ sql: "SELECT 1 WHERE $__orgFilter AND ServiceName IN ('api')" })
	})

	it("escapes single quotes and backslashes against literal breakout", () => {
		const result = interpolateWidgetParams(
			{ sql: "SELECT 1 WHERE x = $v" },
			{ v: single("a' OR '1'='1") },
		)
		expect(result).toEqual({ sql: "SELECT 1 WHERE x = 'a\\' OR \\'1\\'=\\'1'" })

		const backslash = interpolateWidgetParams({ sql: "x = $v" }, { v: single("a\\'b") })
		expect(backslash).toEqual({ sql: "x = 'a\\\\\\'b'" })
	})

	it("expands All to a quoted CSV of every option", () => {
		const result = interpolateWidgetParams(
			{ sql: "ServiceName IN ($service)" },
			{ service: all(["a", "b'c"]) },
		)
		expect(result).toEqual({ sql: "ServiceName IN ('a','b\\'c')" })
	})

	it("expands All with no options to an empty literal", () => {
		const result = interpolateWidgetParams({ sql: "x IN ($v)" }, { v: all([]) })
		expect(result).toEqual({ sql: "x IN ('')" })
	})

	it("applies sql formatting to nested sql keys", () => {
		const result = interpolateWidgetParams(
			{ queries: [{ sql: "x = $v" }] },
			{ v: single("it's") },
		)
		expect(result).toEqual({ queries: [{ sql: "x = 'it\\'s'" }] })
	})
})

describe("interpolateWidgetParams — whereClause", () => {
	it("substitutes raw values inside clause strings", () => {
		const result = interpolateWidgetParams(
			{ whereClause: 'service.name = "$service" AND status = "Error"' },
			{ service: single("api") },
		)
		expect(result).toEqual({ whereClause: 'service.name = "api" AND status = "Error"' })
	})

	it("drops the clause referencing an All selection", () => {
		const result = interpolateWidgetParams(
			{ whereClause: 'service.name = "$service" AND status = "Error"' },
			{ service: all(["a", "b"]) },
		)
		expect(result).toEqual({ whereClause: 'status = "Error"' })
	})

	it("returns an empty whereClause when every clause is dropped", () => {
		const result = interpolateWidgetParams(
			{ whereClause: 'service.name = "$service"' },
			{ service: all(["a"]) },
		)
		expect(result).toEqual({ whereClause: "" })
	})

	it("recurses into queries[i].whereClause", () => {
		const result = interpolateWidgetParams(
			{ queries: [{ whereClause: 'service.name = "$service"' }] },
			{ service: single("api") },
		)
		expect(result).toEqual({ queries: [{ whereClause: 'service.name = "api"' }] })
	})

	it('does not mis-split quoted values containing " and "', () => {
		const result = interpolateWidgetParams(
			{ whereClause: 'span.name = "buy and sell" AND service.name = "$service"' },
			{ service: single("api") },
		)
		expect(result).toEqual({
			whereClause: 'span.name = "buy and sell" AND service.name = "api"',
		})
	})

	it('drops only the All clause when a sibling quoted value contains " and "', () => {
		const result = interpolateWidgetParams(
			{ whereClause: 'span.name = "buy and sell" AND service.name = "$service"' },
			{ service: all(["a", "b"]) },
		)
		expect(result).toEqual({ whereClause: 'span.name = "buy and sell"' })
	})

	it("treats listWhereClause like a whereClause", () => {
		const result = interpolateWidgetParams(
			{ listWhereClause: 'service.name = "$service" AND kind = "server"' },
			{ service: all(["a"]) },
		)
		expect(result).toEqual({ listWhereClause: 'kind = "server"' })
	})
})

describe("interpolateDisplayText", () => {
	it("substitutes values in titles", () => {
		expect(interpolateDisplayText("Latency — $service", { service: single("api") })).toBe(
			"Latency — api",
		)
	})

	it('renders "All" instead of the expanded value list', () => {
		expect(interpolateDisplayText("Latency — $service", { service: all(["a", "b"]) })).toBe(
			"Latency — All",
		)
	})

	it("leaves unknown references and macros literal", () => {
		expect(interpolateDisplayText("$ghost at $__startTime", { service: single("api") })).toBe(
			"$ghost at $__startTime",
		)
	})
})

describe("hasUnresolvedVariableRefs", () => {
	const defined = ["service", "env"]

	it("is false when everything referenced is resolved", () => {
		expect(
			hasUnresolvedVariableRefs({ whereClause: 'x = "$service"' }, defined, {
				service: single("api"),
			}),
		).toBe(false)
	})

	it("is true when a defined variable has no value yet", () => {
		expect(hasUnresolvedVariableRefs({ whereClause: 'x = "$service"' }, defined, {})).toBe(true)
	})

	it("ignores references to undefined names", () => {
		expect(hasUnresolvedVariableRefs({ whereClause: 'x = "$ghost"' }, defined, {})).toBe(false)
	})

	it("ignores $__ macros", () => {
		expect(hasUnresolvedVariableRefs({ sql: "WHERE $__orgFilter" }, defined, {})).toBe(false)
	})

	it("is false without params or without defined variables", () => {
		expect(hasUnresolvedVariableRefs(undefined, defined, {})).toBe(false)
		expect(hasUnresolvedVariableRefs({ whereClause: "$service" }, [], {})).toBe(false)
	})

	it("finds references nested deep in params", () => {
		expect(
			hasUnresolvedVariableRefs({ queries: [{ whereClause: 'x = "${env}"' }] }, defined, {}),
		).toBe(true)
	})
})
