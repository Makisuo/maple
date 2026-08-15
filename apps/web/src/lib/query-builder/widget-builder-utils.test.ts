import type { WidgetDataSource } from "@/components/dashboard-builder/types"
import { describe, expect, it } from "vitest"
import { BREAKDOWN_TAIL_LIMIT, createFormulaDraft, createQueryDraft } from "@maple/query-engine/query-builder"
import {
	buildWidgetDataSource,
	buildWidgetDisplay,
	deriveDefaultWidgetTitle,
	inferDisplayUnitForQuery,
	inferDefaultUnitForQueries,
	toInitialState,
	validateQueries,
	type QueryBuilderWidgetState,
} from "@/lib/query-builder/widget-builder-utils"
import type { DashboardWidget } from "@/components/dashboard-builder/types"

/**
 * What a widget routed to, as one comparable value.
 *
 * v2 answered this with an endpoint string; v3 answers it with `kind` plus, for
 * queries, `resultShape`. Collapsing the two back into a single token keeps these
 * routing assertions reading as routing assertions rather than as narrowing.
 */
const routedTo = (dataSource: WidgetDataSource): string =>
	dataSource.kind === "query" ? dataSource.resultShape : dataSource.kind

/** The query arm's request-shaping fields, which v2 kept in the `params` bag. */
const queryFields = (dataSource: WidgetDataSource): Record<string, unknown> => {
	if (dataSource.kind !== "query") throw new Error(`expected a query source, got ${dataSource.kind}`)
	const { kind: _kind, resultShape: _resultKind, transform: _transform, ...fields } = dataSource
	return fields
}

function makeWidget(): DashboardWidget {
	return {
		id: "widget-1",
		visualization: "chart",
		dataSource: {
			kind: "query",
			resultShape: "timeseries",
			queries: [],
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
		timeRange: null,
		chartId: "query-builder-line",
		stacked: false,
		curveType: "linear",
		queries: [createQueryDraft(0), createQueryDraft(1)],
		formulas: [],
		comparisonMode: "none",
		includePercentChange: true,
		statAggregate: "first",
		statValueField: "",
		unit: "number",
		legendPosition: "bottom",
		seriesStatsEnabled: false,
		pointsMode: "auto",
		tableLimit: "",
		listDataSource: "traces",
		listWhereClause: "",
		listLimit: "",
		listColumns: [],
		listRootOnly: true,
		heatmapColorScale: "blues",
		heatmapScaleType: "linear",
		thresholds: [],
		gaugeMin: "",
		gaugeMax: "",
		sparklineEnabled: false,
		markdownContent: "",
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

		expect(routedTo(dataSource)).toBe("timeseries")
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
			signalSource: "default" as const,
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
			signalSource: "default" as const,
			metricName: "system.memory.usage",
			metricType: "gauge" as const,
			isMonotonic: false,
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
		expect(queryFields(dataSource)).toMatchObject({
			queries: state.queries,
			formulas: state.formulas,
		})
	})
})

describe("funnel/heatmap endpoint routing (MAP-49)", () => {
	it.each(["funnel", "heatmap", "pie", "histogram"] as const)(
		"routes %s widgets to the breakdown endpoint",
		(visualization) => {
			const widget = makeWidget()
			const state = { ...makeState(), visualization }
			const dataSource = buildWidgetDataSource(widget, state, ["A", "B"])
			expect(routedTo(dataSource)).toBe("breakdown")
		},
	)

	it("keeps charts on the timeseries endpoint", () => {
		const widget = makeWidget()
		const dataSource = buildWidgetDataSource(widget, makeState(), ["A", "B"])
		expect(routedTo(dataSource)).toBe("timeseries")
	})

	it("sends breakdown params the endpoint schema accepts, and nothing more", () => {
		// QueryBuilderBreakdownInputSchema accepts only startTime/endTime/queries
		// and the optional defaultLimit. An extra key (formulas, comparison)
		// fails the request decode and leaves the widget stuck on its loading
		// skeleton, so this is a contract test, not a style preference.
		const state = {
			...makeState(),
			visualization: "pie" as const,
			formulas: [createFormulaDraft(0, ["A", "B"])],
		}
		const dataSource = buildWidgetDataSource(makeWidget(), state, ["A", "B"])
		expect(Object.keys(queryFields(dataSource))).toEqual(["queries", "defaultLimit"])
	})

	it("asks for the long tail on a pie, and only on a pie", () => {
		// The pie is the only breakdown panel that collapses its tail into "Other",
		// so it is the only one that fetches past what it draws. Handing 50 rows to
		// a funnel turns a 10-stage funnel into a truncated list.
		const pie = buildWidgetDataSource(makeWidget(), { ...makeState(), visualization: "pie" as const }, [
			"A",
			"B",
		])
		expect(queryFields(pie).defaultLimit).toBe(BREAKDOWN_TAIL_LIMIT)

		for (const visualization of ["funnel", "heatmap", "histogram"] as const) {
			const dataSource = buildWidgetDataSource(makeWidget(), { ...makeState(), visualization }, [
				"A",
				"B",
			])
			expect(queryFields(dataSource).defaultLimit).toBeUndefined()
		}
	})
})

describe("histogram data shape routing", () => {
	function ungroupedTraceState() {
		const base = createQueryDraft(0)
		return {
			...makeState(),
			visualization: "histogram" as const,
			queries: [{ ...base, addOns: { ...base.addOns, groupBy: false }, groupBy: [] }],
		}
	}

	it("routes an ungrouped trace histogram to the list endpoint with a numeric column", () => {
		// An ungrouped histogram is a distribution of raw values bucketized
		// client-side — a count-by-group breakdown is a different chart (MAP-49).
		const dataSource = buildWidgetDataSource(makeWidget(), ungroupedTraceState(), ["A"])
		expect(routedTo(dataSource)).toBe("list")
		expect(queryFields(dataSource)).toMatchObject({ columns: ["durationMs"] })
	})

	it("routes a grouped histogram to the breakdown endpoint", () => {
		const state = { ...makeState(), visualization: "histogram" as const }
		expect(routedTo(buildWidgetDataSource(makeWidget(), state, ["A"]))).toBe("breakdown")
	})

	it("round-trips a list-backed histogram instead of dropping its query", () => {
		const state = ungroupedTraceState()
		const dataSource = buildWidgetDataSource(makeWidget(), state, ["A"])
		const reopened = toInitialState({ ...makeWidget(), visualization: "histogram", dataSource })
		expect(reopened.queries[0].id).toBe(state.queries[0].id)
	})
})

describe("display key ownership across type switches", () => {
	it("replaces a stale chartId when switching a line chart to a pie", () => {
		// The bug this guards: `...widget.display` carried `query-builder-line` into
		// a pie widget, and pie-widget.tsx's `?? "query-builder-pie"` fallback never
		// fires on a defined-but-wrong id — so it mounted a line chart.
		const widget = { ...makeWidget(), display: { chartId: "query-builder-line" } }
		const display = buildWidgetDisplay(widget, { ...makeState(), visualization: "pie" })
		expect(display.chartId).toBe("query-builder-pie")
	})

	it("clears per-visualization keys the new visualization does not own", () => {
		const widget: DashboardWidget = {
			...makeWidget(),
			visualization: "markdown",
			display: {
				markdown: { content: "# note" },
				heatmap: { colorScale: "reds" as const, scaleType: "log" as const },
				gauge: { min: 0, max: 10 },
			},
		}
		const display = buildWidgetDisplay(widget, makeState())
		expect(display.markdown).toBeUndefined()
		expect(display.heatmap).toBeUndefined()
		expect(display.gauge).toBeUndefined()
	})

	it("preserves a non-canonical chart style on a same-category switch", () => {
		const widget = { ...makeWidget(), display: { chartId: "latency-line" } }
		const display = buildWidgetDisplay(widget, { ...makeState(), chartId: "latency-line" })
		expect(display.chartId).toBe("latency-line")
	})

	it("repairs a widget corrupted by the old Chart Style dropdown on open", () => {
		const state = toInitialState({
			...makeWidget(),
			visualization: "chart",
			display: { chartId: "query-builder-pie" },
		})
		expect(state.visualization).toBe("pie")
		expect(state.chartId).toBe("query-builder-pie")
	})
})

describe("markdown widgets", () => {
	it("uses the static endpoint and round-trips its content", () => {
		const state = { ...makeState(), visualization: "markdown" as const, markdownContent: "# Runbook" }
		const dataSource = buildWidgetDataSource(makeWidget(), state, [])
		const display = buildWidgetDisplay(makeWidget(), state)

		expect(routedTo(dataSource)).toBe("static")
		expect(display.markdown).toEqual({ content: "# Runbook" })
		expect(
			toInitialState({ ...makeWidget(), visualization: "markdown", dataSource, display })
				.markdownContent,
		).toBe("# Runbook")
	})
})

describe("validateQueries", () => {
	it("exempts lists and notes, which have no query panels to fix", () => {
		expect(validateQueries({ ...makeState(), visualization: "list" })).toBeNull()
		expect(validateQueries({ ...makeState(), visualization: "markdown" })).toBeNull()
	})

	it("accepts a grouped pie", () => {
		expect(validateQueries({ ...makeState(), visualization: "pie" })).toBeNull()
	})

	it("rejects a de-grouped pie before Apply instead of after Run Preview", () => {
		const base = createQueryDraft(0)
		const state = {
			...makeState(),
			visualization: "pie" as const,
			queries: [{ ...base, addOns: { ...base.addOns, groupBy: false }, groupBy: [] }],
		}
		expect(validateQueries(state)).toMatch(/group-by/)
	})

	it("rejects an ungrouped logs histogram, which has no numeric column to bucketize", () => {
		const base = createQueryDraft(0)
		const state = {
			...makeState(),
			visualization: "histogram" as const,
			queries: [
				{
					...base,
					dataSource: "logs" as const,
					// Logs only support `count`; leaving the traces default here would
					// trip the per-query check first and never reach the histogram rule.
					aggregation: "count",
					addOns: { ...base.addOns, groupBy: false },
					groupBy: [],
				},
			],
		}
		expect(validateQueries(state)).toMatch(/group-by/)
	})
})

describe("deriveDefaultWidgetTitle (MAP-49)", () => {
	it("derives from the default traces draft (error rate grouped by service)", () => {
		expect(deriveDefaultWidgetTitle([createQueryDraft(0)])).toBe("Error rate by service.name")
	})

	it("describes counts and group-bys", () => {
		const draft = { ...createQueryDraft(1), aggregation: "count" }
		expect(deriveDefaultWidgetTitle([draft])).toBe("Count of traces by service.name")
	})

	it("handles logs and metrics sources", () => {
		const logs = { ...createQueryDraft(0), dataSource: "logs" as const, groupBy: ["severity"] }
		expect(deriveDefaultWidgetTitle([logs])).toBe("Count of logs by severity")

		const base = createQueryDraft(0)
		const metrics = {
			...base,
			dataSource: "metrics" as const,
			signalSource: "default" as const,
			metricName: "process.runtime.nodejs.handles",
			metricType: "gauge" as const,
			isMonotonic: false,
			aggregation: "avg",
			addOns: { ...base.addOns, groupBy: false },
		}
		expect(deriveDefaultWidgetTitle([metrics])).toBe("avg of process.runtime.nodejs.handles")
	})

	it("fills an empty saved title with the derived one", () => {
		const widget = makeWidget()
		const display = buildWidgetDisplay(widget, makeState())
		expect(display.title).toBe("Error rate by service.name")
	})

	it("keeps an explicit title", () => {
		const widget = makeWidget()
		const display = buildWidgetDisplay(widget, { ...makeState(), title: "My chart" })
		expect(display.title).toBe("My chart")
	})
})

// The Min/Max/Mean/Last table used to be inferred from legend visibility, which
// switched it on for every widget that showed a legend. It is opt-in now, so a
// widget has to say so — a visible legend on its own must not bring it back.
describe("widget-builder series stats default", () => {
	function widgetWithPresentation(
		chartPresentation: DashboardWidget["display"]["chartPresentation"],
	): DashboardWidget {
		const widget = makeWidget()
		return { ...widget, display: { ...widget.display, chartPresentation } }
	}

	it("leaves the stats table off when the widget does not ask for it", () => {
		expect(toInitialState(widgetWithPresentation({ legend: "visible" })).seriesStatsEnabled).toBe(false)
		expect(toInitialState(widgetWithPresentation(undefined)).seriesStatsEnabled).toBe(false)
	})

	it("honors an explicit flag in both directions", () => {
		expect(
			toInitialState(widgetWithPresentation({ legend: "visible", seriesStats: true }))
				.seriesStatsEnabled,
		).toBe(true)
		expect(
			toInitialState(widgetWithPresentation({ legend: "visible", seriesStats: false }))
				.seriesStatsEnabled,
		).toBe(false)
	})

	it("round-trips the flag back into the saved display config", () => {
		const widget = widgetWithPresentation({ legend: "visible", seriesStats: true })
		const state = toInitialState(widget)
		expect(buildWidgetDisplay(widget, state).chartPresentation?.seriesStats).toBe(true)
	})
})

// Point dots: Auto is the ABSENCE of `showPoints`, so switching back to Auto has
// to remove a previously pinned value rather than leave it in the spread.
describe("widget-builder points mode", () => {
	function widgetWithPresentation(
		chartPresentation: DashboardWidget["display"]["chartPresentation"],
	): DashboardWidget {
		const widget = makeWidget()
		return { ...widget, display: { ...widget.display, chartPresentation } }
	}

	it("reads absent / true / false as auto / always / never", () => {
		expect(toInitialState(widgetWithPresentation({ legend: "visible" })).pointsMode).toBe("auto")
		expect(toInitialState(widgetWithPresentation(undefined)).pointsMode).toBe("auto")
		expect(
			toInitialState(widgetWithPresentation({ legend: "visible", showPoints: true })).pointsMode,
		).toBe("always")
		expect(
			toInitialState(widgetWithPresentation({ legend: "visible", showPoints: false })).pointsMode,
		).toBe("never")
	})

	it("writes always / never as showPoints and drops the key for auto", () => {
		const widget = widgetWithPresentation({ legend: "visible", showPoints: true })
		const state = toInitialState(widget)
		expect(
			buildWidgetDisplay(widget, { ...state, pointsMode: "never" }).chartPresentation?.showPoints,
		).toBe(false)
		const auto = buildWidgetDisplay(widget, { ...state, pointsMode: "auto" }).chartPresentation
		expect(auto).not.toHaveProperty("showPoints")
	})
})
