import { describe, expect, it } from "vitest"
import { getServerFunction, toWidgetRequest } from "./data-source-registry"

/**
 * `toWidgetRequest` is the whole v3 seam on the read path: every widget fetch
 * goes through it, and its output feeds the atom family key, so a drift here is
 * both a wrong query and a poisoned cache entry.
 *
 * The cases below are stated as "the stored data source" → "the request the old
 * endpoint/params code sent", because at schema v2 the two MUST be identical.
 * The v3 arm of each pair asserts the same request from the resultKind it migrates
 * to, which is the property that makes the version flip a no-op here.
 */

const draft = { id: "q1", name: "A", aggregation: "count", dataSource: "traces" }

describe("toWidgetRequest — query-builder widgets", () => {
	it("sends the same endpoint and params v2 stored", () => {
		const v2 = {
			endpoint: "custom_query_builder_timeseries",
			params: { queries: [draft], formulas: [], comparison: { mode: "none" } },
		}
		expect(toWidgetRequest(v2)).toEqual({
			endpoint: "custom_query_builder_timeseries",
			params: { queries: [draft], formulas: [], comparison: { mode: "none" } },
		})
	})

	it("builds the identical request from the v3 resultKind", () => {
		expect(
			toWidgetRequest({
				kind: "query",
				resultShape: "timeseries",
				queries: [draft],
				formulas: [],
				comparison: { mode: "none" },
			}),
		).toEqual(
			toWidgetRequest({
				endpoint: "custom_query_builder_timeseries",
				params: { queries: [draft], formulas: [], comparison: { mode: "none" } },
			}),
		)
	})

	it("maps each result resultKind onto the server function that already serves it", () => {
		for (const [resultKind, endpoint] of [
			["timeseries", "custom_query_builder_timeseries"],
			["breakdown", "custom_query_builder_breakdown"],
			["list", "custom_query_builder_list"],
		] as const) {
			const request = toWidgetRequest({ kind: "query", resultShape: resultKind, queries: [] })
			expect(request?.endpoint).toBe(endpoint)
			expect(getServerFunction(request?.endpoint ?? "")).toBeDefined()
		}
	})

	it("omits formulas and comparison the widget never had", () => {
		// Not `formulas: []` — an empty array is a value the server function would
		// see as "formulas were configured and are empty".
		expect(
			toWidgetRequest({ endpoint: "custom_query_builder_list", params: { queries: [draft] } })?.params,
		).toEqual({ queries: [draft] })
	})
})

describe("toWidgetRequest — raw SQL", () => {
	it("sends the same params v2 stored", () => {
		expect(
			toWidgetRequest({
				endpoint: "raw_sql_chart",
				params: { sql: "SELECT 1", displayType: "line", granularitySeconds: 300 },
			}),
		).toEqual({
			endpoint: "raw_sql_chart",
			params: { sql: "SELECT 1", displayType: "line", granularitySeconds: 300 },
		})
	})

	it("builds the identical request from the v3 resultKind", () => {
		expect(toWidgetRequest({ kind: "raw_sql", sql: "SELECT 1", displayType: "line" })).toEqual(
			toWidgetRequest({ endpoint: "raw_sql_chart", params: { sql: "SELECT 1", displayType: "line" } }),
		)
	})
})

describe("toWidgetRequest — curated routes", () => {
	it("passes the endpoint and its opaque bag straight through", () => {
		expect(toWidgetRequest({ endpoint: "service_overview", params: { limit: 5 } })).toEqual({
			endpoint: "service_overview",
			params: { limit: 5 },
		})
		expect(
			toWidgetRequest({ kind: "route", endpoint: "service_overview", params: { limit: 5 } }),
		).toEqual({ endpoint: "service_overview", params: { limit: 5 } })
	})

	it("gives a route with no bag an empty one, not undefined", () => {
		// The caller spreads `request.params` into the interpolated payload.
		expect(toWidgetRequest({ endpoint: "list_traces" })).toEqual({
			endpoint: "list_traces",
			params: {},
		})
	})

	it("still routes markdown, which the hook special-cases before fetching", () => {
		expect(toWidgetRequest({ endpoint: "markdown_static" })?.endpoint).toBe("markdown_static")
	})

	it("keeps the legacy pre-query-builder endpoints working", () => {
		for (const endpoint of ["custom_timeseries", "custom_breakdown"]) {
			expect(toWidgetRequest({ endpoint, params: { x: 1 } })).toEqual({ endpoint, params: { x: 1 } })
			expect(getServerFunction(endpoint)).toBeDefined()
		}
	})
})

describe("toWidgetRequest — nothing to serve", () => {
	it("returns null rather than a request that cannot resolve", () => {
		// The hook reports this as a disabled tile. Returning a bogus endpoint
		// instead would burn the fetch's two retries on a certain failure.
		expect(toWidgetRequest({ kind: "static" })).toBeNull()
		expect(toWidgetRequest({})).toBeNull()
		expect(toWidgetRequest(null)).toBeNull()
		expect(toWidgetRequest(undefined)).toBeNull()
	})
})
