import { describe, expect, it } from "vitest"
import { unsupportedShareWidgets } from "./share-support"

const widget = (id: string, dataSource: unknown, title?: string) => ({
	id,
	dataSource,
	...(title === undefined ? {} : { display: { title } }),
})

describe("unsupportedShareWidgets", () => {
	it("accepts everything the dashboard builder produces", () => {
		// query / raw_sql / static are built server-side from the stored source, so
		// they never depend on the route allowlist.
		const widgets = [
			widget("w1", { kind: "query", resultShape: "timeseries" }),
			widget("w2", { kind: "raw_sql", sql: "select 1" }),
			widget("w3", { kind: "static" }),
		]
		expect(unsupportedShareWidgets(widgets)).toEqual([])
	})

	it("accepts route widgets on the server's allowlist", () => {
		const widgets = [
			widget("w1", { kind: "route", endpoint: "errors_summary" }),
			widget("w2", { kind: "route", endpoint: "list_logs" }),
		]
		expect(unsupportedShareWidgets(widgets)).toEqual([])
	})

	it("flags route widgets the share resolver cannot serve", () => {
		const widgets = [
			widget("w1", { kind: "route", endpoint: "traces_facets" }, "Trace facets"),
			widget("w2", { kind: "route", endpoint: "list_metrics" }),
		]
		expect(unsupportedShareWidgets(widgets)).toEqual([
			{ id: "w1", title: "Trace facets" },
			// Falls back to the id when the widget has no title, so the warning can
			// still name which tile it means.
			{ id: "w2", title: "w2" },
		])
	})

	it("reads a legacy v2 data source, which has no kind at all", () => {
		// v2 stored `{ endpoint, params }`. Treating a missing `kind` as
		// unsupported would warn about widgets that render perfectly well.
		expect(unsupportedShareWidgets([widget("w1", { endpoint: "errors_summary" })])).toEqual([])
		expect(unsupportedShareWidgets([widget("w2", { endpoint: "traces_facets" })])).toHaveLength(1)
	})

	it("flags a malformed data source rather than assuming it works", () => {
		for (const source of [null, undefined, {}, { kind: "route" }]) {
			expect(unsupportedShareWidgets([widget("w", source)])).toHaveLength(1)
		}
	})
})
