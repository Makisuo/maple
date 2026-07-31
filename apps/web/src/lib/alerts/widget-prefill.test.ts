import { describe, expect, it } from "vitest"

import { defaultRuleForm } from "@/lib/alerts/form-utils"
import { createWidgetAlertPrefill, resolveWidgetAlertPrefill } from "./widget-prefill"

function builderQuery(overrides: Record<string, unknown> = {}) {
	return {
		id: "query-a",
		name: "A",
		enabled: true,
		hidden: false,
		dataSource: "traces",
		aggregation: "count",
		whereClause: "",
		addOns: {
			groupBy: false,
			having: false,
			orderBy: false,
			limit: false,
			legend: false,
		},
		groupBy: ["none"],
		...overrides,
	}
}

describe("createWidgetAlertPrefill", () => {
	it("prefills raw SQL alerts without warnings when SQL returns value", () => {
		const result = createWidgetAlertPrefill(
			{
				id: "w1",
				dataSource: {
					endpoint: "raw_sql_chart",
					params: {
						sql: "SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
					},
				},
				display: { title: "Errors" },
			},
			defaultRuleForm(),
		)

		expect(result.form.signalType).toBe("raw_query")
		expect(result.form.name).toBe("Alert - Errors")
		expect(result.notices).toEqual([])
	})

	it("warns when copied raw SQL does not clearly return value", () => {
		const result = createWidgetAlertPrefill(
			{
				id: "w1",
				dataSource: {
					endpoint: "raw_sql_chart",
					params: {
						sql: "SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket, count() AS errors FROM traces WHERE $__orgFilter GROUP BY bucket",
					},
				},
			},
			defaultRuleForm(),
		)

		expect(result.form.signalType).toBe("raw_query")
		expect(result.notices.map((notice) => notice.message).join("\n")).toContain("numeric value column")
	})

	it("uses the first enabled visible query and warns about multi-query charts", () => {
		const result = createWidgetAlertPrefill(
			{
				id: "w1",
				dataSource: {
					endpoint: "custom_query_builder_timeseries",
					params: {
						queries: [
							builderQuery({
								id: "disabled",
								name: "A",
								enabled: false,
								whereClause: 'service.name = "ignored"',
							}),
							builderQuery({
								id: "selected",
								name: "B",
								whereClause: 'service.name = "checkout"',
							}),
							builderQuery({ id: "third", name: "C", whereClause: 'service.name = "billing"' }),
						],
					},
				},
				display: { title: "Traffic" },
			},
			defaultRuleForm(),
		)

		expect(result.form.signalType).toBe("builder_query")
		expect(result.form.queryWhereClause).toBe('service.name = "checkout"')
		expect(result.form.name).toBe("Alert - Traffic")
		expect(result.notices.map((notice) => notice.message).join("\n")).toContain("2 visible queries")
	})

	it("seeds a ratio-scale threshold for error_rate builder queries", () => {
		const result = createWidgetAlertPrefill(
			{
				id: "w1",
				dataSource: {
					endpoint: "custom_query_builder_timeseries",
					params: {
						queries: [builderQuery({ aggregation: "error_rate" })],
					},
				},
			},
			defaultRuleForm(),
		)

		// error_rate evaluates as a 0–1 ratio; the blank-form default of "5"
		// (percent entry for the built-in signal) would mean 500%.
		expect(result.form.threshold).toBe("0.05")
	})

	it("keeps the default threshold for non-ratio aggregations", () => {
		const result = createWidgetAlertPrefill(
			{
				id: "w1",
				dataSource: {
					endpoint: "custom_query_builder_timeseries",
					params: { queries: [builderQuery({ aggregation: "count" })] },
				},
			},
			defaultRuleForm(),
		)

		expect(result.form.threshold).toBe(defaultRuleForm().threshold)
	})

	it("surfaces metrics query validation issues", () => {
		const result = createWidgetAlertPrefill(
			{
				id: "w1",
				dataSource: {
					endpoint: "custom_query_builder_timeseries",
					params: {
						queries: [
							builderQuery({
								dataSource: "metrics",
								aggregation: "avg",
								metricName: "",
								metricType: "gauge",
							}),
						],
					},
				},
			},
			defaultRuleForm(),
		)

		expect(result.form.queryDataSource).toBe("metrics")
		expect(result.notices.map((notice) => notice.message).join("\n")).toContain(
			"Metric source requires a metric name",
		)
	})
})

describe("resolveWidgetAlertPrefill", () => {
	it("reloads the source widget when an oversized snapshot falls back to ids", () => {
		const result = resolveWidgetAlertPrefill({
			dashboards: [
				{
					id: "dash",
					widgets: [
						{
							id: "w1",
							dataSource: {
								endpoint: "raw_sql_chart",
								params: { sql: "SELECT count() AS value FROM traces WHERE $__orgFilter" },
							},
						},
					],
				},
			],
			dashboardId: "dash",
			widgetId: "w1",
			base: defaultRuleForm(),
		})

		expect(result.form.signalType).toBe("raw_query")
		expect(result.form.rawQuerySql).toContain("$__orgFilter")
	})

	it("returns a clear notice when either fallback id is missing", () => {
		const missingDashboard = resolveWidgetAlertPrefill({
			dashboards: [],
			widgetId: "w1",
			base: defaultRuleForm(),
		})
		const missingWidget = resolveWidgetAlertPrefill({
			dashboards: [],
			dashboardId: "dash",
			base: defaultRuleForm(),
		})

		expect(missingDashboard.notices[0]?.message).toContain("dashboard id was missing")
		expect(missingWidget.notices[0]?.message).toContain("chart id was missing")
	})
})
