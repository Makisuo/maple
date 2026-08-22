import { describe, expect, it } from "vitest"
import { dataSourceEndpoint, dataSourceQuerySet, dataSourceRawSql, dataSourceRouteParams } from "./access"
import {
	makeProductEventsFunnelDataSource,
	makeQueryDataSource,
	makeRawSqlDataSource,
	makeRouteDataSource,
	PRODUCT_EVENTS_FUNNEL_ENDPOINT,
} from "./construct"

/**
 * The round trip is the whole contract: whatever a constructor writes, the
 * matching accessor must read back unchanged. That property is what makes the
 * v2 → v3 flip an edit to these two files rather than a sweep of every writer,
 * so it is asserted per constructor rather than left to the version bump.
 */

const draft = { id: "q1", name: "A", aggregation: "count", dataSource: "traces" } as const
const formula = { id: "f1", name: "F1", expression: "A / B", legend: "ratio" }

describe("makeQueryDataSource", () => {
	it("round-trips every result shape", () => {
		for (const resultKind of ["timeseries", "breakdown", "list"] as const) {
			const input = { resultShape: resultKind, queries: [draft] }
			expect(dataSourceQuerySet(makeQueryDataSource(input))).toEqual({
				...input,
				formulas: undefined,
				comparison: undefined,
			})
		}
	})

	it("round-trips formulas and a comparison window", () => {
		const input = {
			resultShape: "timeseries",
			queries: [draft],
			formulas: [formula],
			comparison: { mode: "previous_period", includePercentChange: true },
		} as const
		expect(dataSourceQuerySet(makeQueryDataSource(input))).toEqual(input)
	})

	it("omits formulas and comparison rather than writing empty keys", () => {
		// A widget that never had formulas must not become indistinguishable from
		// one that lost them on the next read-modify-write.
		expect(makeQueryDataSource({ resultShape: "list", queries: [] })).toEqual({
			kind: "query",
			resultShape: "list",
			queries: [],
		})
	})

	// A query data source has no endpoint in v3 — its identity is `kind` plus
	// `resultShape`. `dataSourceEndpoint` returning null here rather than
	// synthesising `custom_query_builder_breakdown` is the property that stops the
	// string-sniffing creeping back in.
	it("writes no endpoint for a query source", () => {
		const source = makeQueryDataSource({ resultShape: "breakdown", queries: [] })

		expect(source.kind).toBe("query")
		expect(source.resultShape).toBe("breakdown")
		expect(dataSourceEndpoint(source)).toBeNull()
	})

	it("carries a transform through untouched", () => {
		const transform = { reduceToValue: { field: "value", aggregate: "first" } } as const
		expect(makeQueryDataSource({ resultShape: "timeseries", queries: [], transform }).transform).toEqual(
			transform,
		)
	})
})

describe("makeRawSqlDataSource", () => {
	it("round-trips a full payload", () => {
		const input = { sql: "SELECT 1", displayType: "line", granularitySeconds: 60 }
		expect(dataSourceRawSql(makeRawSqlDataSource(input))).toEqual(input)
	})

	it("round-trips a bare SQL string", () => {
		expect(dataSourceRawSql(makeRawSqlDataSource({ sql: "SELECT 1" }))).toEqual({
			sql: "SELECT 1",
			displayType: undefined,
			granularitySeconds: undefined,
		})
	})

	it("is not readable as a query set", () => {
		expect(dataSourceQuerySet(makeRawSqlDataSource({ sql: "SELECT 1" }))).toBeNull()
	})
})

describe("makeRouteDataSource", () => {
	it("round-trips through dataSourceEndpoint", () => {
		expect(dataSourceEndpoint(makeRouteDataSource("service_overview", { limit: 5 }))).toBe(
			"service_overview",
		)
	})

	it("is neither a query set nor raw SQL", () => {
		const source = makeRouteDataSource("service_overview")
		expect(dataSourceQuerySet(source)).toBeNull()
		expect(dataSourceRawSql(source)).toBeNull()
	})

	it("omits an absent params bag rather than writing an empty one", () => {
		expect(makeRouteDataSource("service_overview")).toEqual({
			kind: "route",
			endpoint: "service_overview",
		})
	})
})

describe("makeProductEventsFunnelDataSource", () => {
	const steps = [
		{ kind: "page" as const, pagePath: "/pricing" },
		{ kind: "event" as const, eventName: "signup_completed" },
	]

	it("is a route the accessors read back, with the definition as its params", () => {
		const source = makeProductEventsFunnelDataSource({ steps, keyBy: "person", windowSeconds: 3600 })
		expect(dataSourceEndpoint(source)).toBe(PRODUCT_EVENTS_FUNNEL_ENDPOINT)
		expect(dataSourceRouteParams(source)).toEqual({ steps, keyBy: "person", windowSeconds: 3600 })
		expect(dataSourceQuerySet(source)).toBeNull()
		expect(dataSourceRawSql(source)).toBeNull()
	})

	it("forwards only the definition fields that are set", () => {
		expect(dataSourceRouteParams(makeProductEventsFunnelDataSource({ steps }))).toEqual({ steps })
	})

	it("spreads the population filters flat and forwards the breakdown", () => {
		const source = makeProductEventsFunnelDataSource({
			steps,
			breakdownBy: "referrerHost",
			filters: { country: "DE", utmSource: "twitter", host: undefined, pagePath: "" },
		})
		expect(dataSourceRouteParams(source)).toEqual({
			steps,
			breakdownBy: "referrerHost",
			country: "DE",
			utmSource: "twitter",
		})
	})
})
