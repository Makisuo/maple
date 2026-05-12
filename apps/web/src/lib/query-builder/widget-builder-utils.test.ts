import { describe, expect, it } from "vitest"
import { createFormulaDraft, createQueryDraft } from "@/lib/query-builder/model"
import {
	buildWidgetDataSource,
	buildWidgetDisplay,
	inferDisplayUnitForQuery,
	inferDefaultUnitForQueries,
	type QueryBuilderWidgetState,
} from "@/lib/query-builder/widget-builder-utils"
import type { DashboardWidget } from "@/components/dashboard-builder/types"

function makeWidget(): DashboardWidget {
	return {
		id: "widget-1",
		visualization: "chart",
		dataSource: {
			endpoint: "custom_query_builder_timeseries",
			params: {},
		},
		display: {},
		layout: { x: 0, y: 0, w: 6, h: 4 },
	}
}

function makeState(): QueryBuilderWidgetState {
	return {
		visualization: "chart",
		title: "",
		description: "",
		chartId: "query-builder-line",
		stacked: false,
		curveType: "linear",
		queries: [createQueryDraft(0), createQueryDraft(1)],
		formulas: [],
		comparisonMode: "none",
		includePercentChange: true,
		debug: false,
		statAggregate: "first",
		statValueField: "",
		unit: "number",
		legendPosition: "bottom",
		tableLimit: "",
		listDataSource: "traces",
		listWhereClause: "",
		listLimit: "",
		listColumns: [],
		listRootOnly: true,
		heatmapColorScale: "blues",
		heatmapScaleType: "linear",
	}
}

describe("widget-builder hidden series behavior", () => {
	it("does not use the breakdown endpoint when grouped queries are hidden", () => {
		const widget = makeWidget()
		const state = makeState()

		state.visualization = "table"
		state.queries[0] = {
			...state.queries[0],
			hidden: true,
			addOns: { ...state.queries[0].addOns, groupBy: true },
			groupBy: ["service.name"],
		}
		state.queries[1] = {
			...state.queries[1],
			addOns: { ...state.queries[1].addOns, groupBy: false },
			groupBy: ["none"],
		}

		const dataSource = buildWidgetDataSource(widget, state, ["A", "B"])

		expect(dataSource.endpoint).toBe("custom_query_builder_timeseries")
		expect(dataSource.transform?.hideSeries?.baseNames).toEqual(["A"])
	})

	it("uses the first visible grouped query to define table columns", () => {
		const widget = makeWidget()
		const state = makeState()

		state.visualization = "table"
		state.queries[0] = {
			...state.queries[0],
			hidden: true,
			aggregation: "count",
			addOns: { ...state.queries[0].addOns, groupBy: true },
			groupBy: ["service.name"],
		}
		state.queries[1] = {
			...state.queries[1],
			hidden: false,
			aggregation: "error_rate",
			addOns: { ...state.queries[1].addOns, groupBy: true },
			groupBy: ["status.code"],
		}

		const display = buildWidgetDisplay(widget, state)

		expect(display.columns).toEqual([
			{ field: "name", header: "status.code", align: "left" },
			{ field: "value", header: "error_rate", unit: "percent", align: "right" },
		])
	})

	it("defaults the widget unit to percent when all active queries use error rate", () => {
		const state = makeState()
		state.queries = state.queries.map((query) => ({
			...query,
			aggregation: "error_rate",
		}))

		expect(inferDefaultUnitForQueries(state.queries)).toBe("percent")
	})

	it("defaults traces latency queries to duration units", () => {
		const state = makeState()
		state.queries = [
			{
				...state.queries[0],
				aggregation: "p95_duration",
			},
		]

		expect(inferDefaultUnitForQueries(state.queries)).toBe("duration_ms")
	})

	it("defaults metric rate queries to requests/sec", () => {
		const query = {
			...createQueryDraft(0),
			dataSource: "metrics" as const,
			metricName: "http.server.requests",
			metricType: "sum" as const,
			isMonotonic: true,
			aggregation: "rate",
		}

		expect(inferDisplayUnitForQuery(query)).toBe("requests_per_sec")
	})

	it("defaults memory-like metrics to bytes", () => {
		const query = {
			...createQueryDraft(0),
			dataSource: "metrics" as const,
			metricName: "system.memory.usage",
			metricType: "gauge" as const,
			aggregation: "avg",
		}

		expect(inferDisplayUnitForQuery(query)).toBe("bytes")
	})

	it("does not default the widget unit to percent for mixed aggregations", () => {
		const state = makeState()
		state.queries[0] = {
			...state.queries[0],
			aggregation: "error_rate",
		}
		state.queries[1] = {
			...state.queries[1],
			aggregation: "count",
		}

		expect(inferDefaultUnitForQueries(state.queries)).toBeUndefined()
	})

	it("writes hidden query and formula names into the shared transform", () => {
		const widget = makeWidget()
		const state = makeState()
		const formula = createFormulaDraft(0, ["A", "B"])

		state.queries[0] = {
			...state.queries[0],
			hidden: true,
			legend: "Errors",
		}
		state.formulas = [
			{
				...formula,
				hidden: true,
				legend: "Error ratio",
			},
		]

		const dataSource = buildWidgetDataSource(widget, state, ["B"])

		expect(dataSource.transform?.hideSeries?.baseNames).toEqual(["Errors", "Error ratio"])
		expect(dataSource.params).toMatchObject({
			queries: state.queries,
			formulas: state.formulas,
		})
	})
})
