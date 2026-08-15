import { describe, expect, it } from "vitest"

import { type VariableValues } from "./dashboard-variables/interpolate"
import { snapRangeForCache } from "./datetime"
import { MAX_LIST_RANGE_SECONDS } from "./limits"
import { WIDGET_FETCH_STRATEGY, planWidgetRequest } from "./widget-request"

const single = (value: string): VariableValues[string] => ({ value, isAll: false, options: [] })

const NOW_MS = Date.parse("2026-03-10T12:00:00Z")
const DASHBOARD = { startTime: "2026-03-10 00:00:00", endTime: "2026-03-10 12:00:00" }

const timeseriesRequest = {
	endpoint: "custom_query_builder_timeseries",
	params: {
		queries: [{ id: "a", whereClause: "service.name = '$service' AND env = '$env'" }],
	},
}

describe("planWidgetRequest", () => {
	it("pins the strategy and window every dashboard tile sends", () => {
		const plan = planWidgetRequest({ request: timeseriesRequest, dashboardWindow: DASHBOARD })
		expect(plan.kind).toBe("request")
		if (plan.kind !== "request") return
		expect(plan.window).toEqual(DASHBOARD)
		expect(plan.params.strategy).toEqual(WIDGET_FETCH_STRATEGY)
		expect(plan.params.startTime).toBe(DASHBOARD.startTime)
		expect(plan.params.endTime).toBe(DASHBOARD.endTime)
	})

	it("substitutes variables inside nested query-set where clauses", () => {
		const plan = planWidgetRequest({
			request: timeseriesRequest,
			dashboardWindow: DASHBOARD,
			variableValues: { service: single("checkout"), env: single("prod") },
		})
		if (plan.kind !== "request") throw new Error("expected a request")
		const queries = plan.params.queries as ReadonlyArray<{ whereClause: string }>
		expect(queries[0].whereClause).toBe("service.name = 'checkout' AND env = 'prod'")
	})

	it("substitutes variables into raw SQL as escaped literals", () => {
		const plan = planWidgetRequest({
			request: {
				endpoint: "raw_sql_chart",
				params: { sql: "SELECT 1 WHERE service = $service", displayType: "line" },
			},
			dashboardWindow: DASHBOARD,
			variableValues: { service: single("o'neil") },
		})
		if (plan.kind !== "request") throw new Error("expected a request")
		expect(plan.params.sql).toBe("SELECT 1 WHERE service = 'o\\'neil'")
		expect(plan.params.displayType).toBe("line")
	})

	it("fills time macros before substituting variables", () => {
		const plan = planWidgetRequest({
			request: { endpoint: "service_overview", params: { since: "$__startTime", name: "$service" } },
			dashboardWindow: DASHBOARD,
			variableValues: { service: single("$__endTime") },
		})
		if (plan.kind !== "request") throw new Error("expected a request")
		expect(plan.params.since).toBe(DASHBOARD.startTime)
		// A variable value that happens to look like a macro is not re-expanded.
		expect(plan.params.name).toBe("$__endTime")
	})

	it("lets a widget's own time range beat the dashboard window, snapped like the browser", () => {
		const plan = planWidgetRequest({
			request: timeseriesRequest,
			dashboardWindow: DASHBOARD,
			widgetTimeRange: { type: "relative", value: "24h" },
			nowMs: NOW_MS,
		})
		if (plan.kind !== "request") throw new Error("expected a request")
		expect(plan.window).toEqual(
			snapRangeForCache({ startTime: "2026-03-09 12:00:00", endTime: "2026-03-10 12:00:00" }),
		)
		expect(plan.params.startTime).toBe(plan.window.startTime)
		expect(plan.params.endTime).toBe(plan.window.endTime)
	})

	it("normalises an absolute widget range through the warehouse parser", () => {
		const plan = planWidgetRequest({
			request: timeseriesRequest,
			dashboardWindow: DASHBOARD,
			widgetTimeRange: {
				type: "absolute",
				startTime: "2026-03-01T00:00:00.000Z",
				endTime: "2026-03-02T00:00:00.000Z",
			},
		})
		if (plan.kind !== "request") throw new Error("expected a request")
		expect(plan.window).toEqual({ startTime: "2026-03-01 00:00:00", endTime: "2026-03-02 00:00:00" })
	})

	it("reports an unresolvable widget range instead of guessing", () => {
		const plan = planWidgetRequest({
			request: timeseriesRequest,
			dashboardWindow: DASHBOARD,
			widgetTimeRange: { type: "relative", value: "sometime" },
		})
		expect(plan).toEqual({ kind: "disabled", reason: "invalid_widget_time_range" })
	})

	it("flags a list endpoint over the list cap and nothing else", () => {
		const wide = { startTime: "2026-02-01 00:00:00", endTime: "2026-03-10 00:00:00" }
		const list = planWidgetRequest({
			request: { endpoint: "custom_query_builder_list", params: { queries: [] } },
			dashboardWindow: wide,
		})
		const chart = planWidgetRequest({ request: timeseriesRequest, dashboardWindow: wide })
		if (list.kind !== "request" || chart.kind !== "request") throw new Error("expected requests")
		expect(list.exceedsListCap).toBe(true)
		expect(chart.exceedsListCap).toBe(false)

		const justUnder = {
			startTime: "2026-03-03 00:00:00",
			endTime: `2026-03-10 00:00:00`,
		}
		expect((MAX_LIST_RANGE_SECONDS / 86_400) | 0).toBe(7)
		const atCap = planWidgetRequest({
			request: { endpoint: "custom_query_builder_list", params: { queries: [] } },
			dashboardWindow: justUnder,
		})
		if (atCap.kind !== "request") throw new Error("expected a request")
		expect(atCap.exceedsListCap).toBe(false)
	})

	it("attaches maxDataPoints to timeseries requests only", () => {
		const timeseries = planWidgetRequest({
			request: timeseriesRequest,
			dashboardWindow: DASHBOARD,
			maxDataPoints: 800,
		})
		const breakdown = planWidgetRequest({
			request: { endpoint: "custom_query_builder_breakdown", params: { queries: [] } },
			dashboardWindow: DASHBOARD,
			maxDataPoints: 800,
		})
		if (timeseries.kind !== "request" || breakdown.kind !== "request")
			throw new Error("expected requests")
		expect(timeseries.params.maxDataPoints).toBe(800)
		expect(breakdown.params).not.toHaveProperty("maxDataPoints")
	})
})
