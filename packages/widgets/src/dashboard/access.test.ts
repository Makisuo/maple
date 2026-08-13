import { describe, expect, it } from "vitest"
import {
	dataSourceEndpoint,
	dataSourceQuerySet,
	dataSourceRawSql,
	dataSourceRouteParams,
	isQueryDataSource,
} from "./access"

/**
 * The accessors' whole job is that a v2 data source and the v3 one it migrates
 * to read IDENTICALLY. Each case below states both shapes and asserts one
 * result, so a drift between them fails here rather than at the version flip.
 */

const draft = { id: "q1", name: "A", aggregation: "count", dataSource: "traces" }
const formula = { id: "f1", name: "F1", expression: "A / B", legend: "ratio" }

describe("dataSourceQuerySet", () => {
	it("reads a timeseries query set from either version", () => {
		const v2 = {
			endpoint: "custom_query_builder_timeseries",
			params: { queries: [draft], formulas: [formula], comparison: { mode: "previous_period" } },
		}
		const v3 = {
			kind: "query",
			resultShape: "timeseries",
			queries: [draft],
			formulas: [formula],
			comparison: { mode: "previous_period" },
		}
		const expected = {
			resultShape: "timeseries",
			queries: [draft],
			formulas: [formula],
			comparison: { mode: "previous_period" },
		}
		expect(dataSourceQuerySet(v2)).toEqual(expected)
		expect(dataSourceQuerySet(v3)).toEqual(expected)
	})

	it("derives the result shape from the endpoint on v2", () => {
		expect(dataSourceQuerySet({ endpoint: "custom_query_builder_breakdown" })?.resultShape).toBe(
			"breakdown",
		)
		expect(dataSourceQuerySet({ endpoint: "custom_query_builder_list" })?.resultShape).toBe("list")
	})

	it("returns null for a fixed-route endpoint", () => {
		expect(dataSourceQuerySet({ endpoint: "service_overview", params: { x: 1 } })).toBeNull()
		expect(dataSourceQuerySet({ kind: "route", endpoint: "service_overview" })).toBeNull()
	})

	it("returns null for raw SQL, markdown and junk", () => {
		expect(dataSourceQuerySet({ endpoint: "raw_sql_chart" })).toBeNull()
		expect(dataSourceQuerySet({ kind: "raw_sql", sql: "SELECT 1" })).toBeNull()
		expect(dataSourceQuerySet({ kind: "static" })).toBeNull()
		expect(dataSourceQuerySet(null)).toBeNull()
		expect(dataSourceQuerySet("nope")).toBeNull()
	})

	it("reports what is stored rather than what would decode", () => {
		// A read accessor, not a validator. The MCP inspector and the template
		// checker both want to see the malformed draft in order to report on it;
		// silently dropping it would make a broken widget look empty.
		const malformed = { id: "q1" }
		expect(
			dataSourceQuerySet({ kind: "query", resultShape: "list", queries: [malformed] })?.queries,
		).toEqual([malformed])
	})

	it("treats absent or non-array queries as empty, not as a failure", () => {
		expect(dataSourceQuerySet({ endpoint: "custom_query_builder_timeseries" })?.queries).toEqual([])
		expect(
			dataSourceQuerySet({ endpoint: "custom_query_builder_timeseries", params: { queries: "x" } })
				?.queries,
		).toEqual([])
	})
})

describe("dataSourceRawSql", () => {
	it("reads the payload from either version", () => {
		const expected = { sql: "SELECT 1", displayType: "line", granularitySeconds: 60 }
		expect(
			dataSourceRawSql({
				endpoint: "raw_sql_chart",
				params: { sql: "SELECT 1", displayType: "line", granularitySeconds: 60 },
			}),
		).toEqual(expected)
		expect(
			dataSourceRawSql({
				kind: "raw_sql",
				sql: "SELECT 1",
				displayType: "line",
				granularitySeconds: 60,
			}),
		).toEqual(expected)
	})

	it("returns an empty string for a widget saved before any SQL was written", () => {
		// Representable and meaningful — callers warn about it. Null would make it
		// indistinguishable from "this isn't a raw-SQL widget".
		expect(dataSourceRawSql({ endpoint: "raw_sql_chart", params: {} })?.sql).toBe("")
		expect(dataSourceRawSql({ kind: "raw_sql" })?.sql).toBe("")
	})

	it("returns null for anything that is not raw SQL", () => {
		expect(dataSourceRawSql({ endpoint: "custom_query_builder_timeseries" })).toBeNull()
		expect(dataSourceRawSql({ kind: "query", resultShape: "timeseries", queries: [] })).toBeNull()
	})
})

describe("dataSourceEndpoint", () => {
	it("reads the endpoint on v2 and on a v3 route", () => {
		expect(dataSourceEndpoint({ endpoint: "service_overview" })).toBe("service_overview")
		expect(dataSourceEndpoint({ kind: "route", endpoint: "service_overview" })).toBe("service_overview")
	})

	it("returns null for a typed v3 arm rather than inventing a legacy name", () => {
		// Synthesising "custom_query_builder_timeseries" here would re-create the
		// endpoint-string sniffing the typed union exists to remove.
		expect(dataSourceEndpoint({ kind: "query", resultShape: "timeseries", queries: [] })).toBeNull()
		expect(dataSourceEndpoint({ kind: "raw_sql", sql: "" })).toBeNull()
		expect(dataSourceEndpoint({ kind: "static" })).toBeNull()
	})
})

describe("dataSourceRouteParams", () => {
	it("reads the bag for a curated route on either version", () => {
		expect(dataSourceRouteParams({ endpoint: "service_overview", params: { limit: 5 } })).toEqual({
			limit: 5,
		})
		expect(
			dataSourceRouteParams({ kind: "route", endpoint: "service_overview", params: { limit: 5 } }),
		).toEqual({ limit: 5 })
	})

	it("returns undefined for a typed v3 arm — nothing opaque is left", () => {
		expect(dataSourceRouteParams({ kind: "query", resultShape: "list", queries: [] })).toBeUndefined()
		expect(dataSourceRouteParams({ kind: "raw_sql", sql: "SELECT 1" })).toBeUndefined()
	})

	it("refuses the v2 bag of a query-builder or raw-SQL widget", () => {
		// The asymmetry guard: on v2 these physically have a `params` bag, and
		// handing it back would give v2 an answer v3 cannot give — a caller written
		// against it would break at the version flip, silently.
		expect(
			dataSourceRouteParams({
				endpoint: "custom_query_builder_timeseries",
				params: { queries: [draft] },
			}),
		).toBeUndefined()
		expect(
			dataSourceRouteParams({ endpoint: "raw_sql_chart", params: { sql: "SELECT 1" } }),
		).toBeUndefined()
	})
})

describe("isQueryDataSource", () => {
	it("agrees with dataSourceQuerySet across both versions", () => {
		for (const source of [
			{ endpoint: "custom_query_builder_timeseries", params: { queries: [draft] } },
			{ kind: "query", resultShape: "timeseries", queries: [draft] },
			{ endpoint: "service_overview" },
			{ kind: "raw_sql", sql: "SELECT 1" },
			null,
		]) {
			expect(isQueryDataSource(source)).toBe(dataSourceQuerySet(source) !== null)
		}
	})
})
