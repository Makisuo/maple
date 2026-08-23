import { describe, expect, it } from "vitest"

import { makeQueryDataSource, makeRawSqlDataSource } from "@maple/widgets/dashboard"

import { defaultRuleForm } from "@/lib/alerts/form-utils"
import { toBase64Url } from "@/lib/base64url"
import {
	decodeAlertChartFromSearchParam,
	encodeAlertChartToSearchParam,
	type AlertChartContext,
} from "./widget-chart-param"
import { createWidgetAlertPrefill } from "./widget-prefill"

const builderWidgetContext: AlertChartContext = {
	dashboardId: "dash-1",
	widget: {
		id: "w1",
		visualization: "timeseries",
		dataSource: {
			endpoint: "custom_query_builder_timeseries",
			params: {
				queries: [
					{
						id: "query-a",
						name: "A",
						dataSource: "traces",
						aggregation: "count",
						// base64url-hostile content: quotes, unicode, +, /, =
						whereClause: 'service.name = "café/checkout+v2" AND attr.note = "a=b"',
						addOns: {
							groupBy: false,
							having: false,
							orderBy: false,
							limit: false,
							legend: false,
						},
						groupBy: [],
					},
				],
			},
		},
		display: { title: "Tráffic ✓" },
	},
}

describe("encodeAlertChartToSearchParam / decodeAlertChartFromSearchParam", () => {
	it("round-trips a widget snapshot including unicode and base64-hostile characters", () => {
		const encoded = encodeAlertChartToSearchParam(builderWidgetContext)
		expect(encoded).toBeDefined()
		// URL-safe alphabet only
		expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)

		const decoded = decodeAlertChartFromSearchParam(encoded!)
		expect(decoded).toEqual(builderWidgetContext)
	})

	it("returns undefined for garbage input", () => {
		expect(decodeAlertChartFromSearchParam("!!!not-base64url***")).toBeUndefined()
	})

	it("returns undefined for valid base64url of non-JSON", () => {
		expect(decodeAlertChartFromSearchParam(toBase64Url("definitely not json"))).toBeUndefined()
	})

	it("returns undefined when the payload fails schema validation", () => {
		const missingWidgetId = toBase64Url(
			JSON.stringify({ dashboardId: "dash-1", widget: { visualization: "timeseries" } }),
		)
		expect(decodeAlertChartFromSearchParam(missingWidgetId)).toBeUndefined()
	})

	it("refuses to encode oversized widgets so callers fall back to the id lookup", () => {
		const oversized: AlertChartContext = {
			dashboardId: "dash-1",
			widget: {
				id: "w1",
				dataSource: { endpoint: "raw_sql_chart", params: { sql: "SELECT 1 -- ".repeat(2_000) } },
			},
		}
		expect(encodeAlertChartToSearchParam(oversized)).toBeUndefined()
	})

	it("produces the same prefill as handing the widget to createWidgetAlertPrefill directly", () => {
		const encoded = encodeAlertChartToSearchParam(builderWidgetContext)
		const decoded = decodeAlertChartFromSearchParam(encoded!)

		const viaParam = createWidgetAlertPrefill(decoded!.widget, defaultRuleForm())
		const direct = createWidgetAlertPrefill(builderWidgetContext.widget, defaultRuleForm())

		expect(viaParam).toEqual(direct)
		expect(viaParam.form.signalType).toBe("builder_query")
		expect(viaParam.form.queryBuilderDraft.whereClause).toBe(
			'service.name = "café/checkout+v2" AND attr.note = "a=b"',
		)
	})

	// The builder has written v3 data sources (`{ kind: "query" | "raw_sql" }`)
	// since the schema flip; the param schema still described the v2
	// `{ endpoint, params }` shape, and Effect Schema drops excess properties on
	// decode — so every real "Create alert" navigation arrived with an empty data
	// source and painted a blank form. Built with the real constructors so the
	// test follows the stored shape rather than a copy of it.
	it("round-trips a v3 query-set widget instead of stripping it to a blank form", () => {
		const ctx: AlertChartContext = {
			dashboardId: "dash-1",
			widget: {
				id: "w3",
				visualization: "timeseries",
				dataSource: makeQueryDataSource({
					resultShape: "timeseries",
					queries: [
						{
							id: "query-a",
							name: "A",
							enabled: true,
							hidden: false,
							dataSource: "traces",
							aggregation: "count",
							whereClause: 'service.name = "checkout"',
							addOns: {
								groupBy: false,
								having: false,
								orderBy: false,
								limit: false,
								legend: false,
							},
							groupBy: ["none"],
						},
					],
				}),
				display: { title: "v3 traffic" },
			},
		}

		const decoded = decodeAlertChartFromSearchParam(encodeAlertChartToSearchParam(ctx)!)
		expect(decoded?.widget.dataSource).toEqual(ctx.widget.dataSource)

		const prefill = createWidgetAlertPrefill(decoded!.widget, defaultRuleForm())
		expect(prefill.form.signalType).toBe("builder_query")
		expect(prefill.form.name).toBe("Alert - v3 traffic")
		expect(prefill.form.queryBuilderDraft.whereClause).toBe('service.name = "checkout"')
		expect(prefill.notices).toEqual([])
	})

	it("round-trips a v3 raw SQL widget with its reducer transform", () => {
		const sql = "SELECT max(Duration) AS value FROM traces WHERE $__orgFilter"
		const ctx: AlertChartContext = {
			dashboardId: "dash-1",
			widget: {
				id: "w4",
				dataSource: makeRawSqlDataSource({
					sql,
					transform: { reduceToValue: { field: "value", aggregate: "max" } },
				}),
				display: { title: "Slowest" },
			},
		}

		const decoded = decodeAlertChartFromSearchParam(encodeAlertChartToSearchParam(ctx)!)
		expect(decoded?.widget.dataSource).toEqual(ctx.widget.dataSource)

		const prefill = createWidgetAlertPrefill(decoded!.widget, defaultRuleForm())
		expect(prefill.form.signalType).toBe("raw_query")
		expect(prefill.form.rawQuerySql).toBe(sql)
		expect(prefill.form.rawQueryReducer).toBe("max")
	})

	it("round-trips a raw SQL widget keeping the SQL intact", () => {
		const sql =
			"SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket, count() AS value FROM traces WHERE $__orgFilter GROUP BY bucket"
		const ctx: AlertChartContext = {
			dashboardId: "dash-1",
			widget: {
				id: "w2",
				dataSource: { endpoint: "raw_sql_chart", params: { sql } },
				display: { title: "Raw" },
			},
		}

		const decoded = decodeAlertChartFromSearchParam(encodeAlertChartToSearchParam(ctx)!)
		const prefill = createWidgetAlertPrefill(decoded!.widget, defaultRuleForm())

		expect(prefill.form.signalType).toBe("raw_query")
		expect(prefill.form.rawQuerySql).toBe(sql)
	})
})
