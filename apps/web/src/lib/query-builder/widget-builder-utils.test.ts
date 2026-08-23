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
import { defaultFunnelDraft } from "@/lib/query-builder/widget-builder-shared"

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
		funnel: defaultFunnelDraft(),
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

describe("product-event funnel widget", () => {
	const funnelState = (): QueryBuilderWidgetState => ({
		...makeState(),
		visualization: "funnel",
		chartId: "query-builder-funnel",
		// A placeholder draft with no group-by — what the shared validation would
		// reject if it ran; the funnel definition owns the source instead.
		queries: [
			{
				...createQueryDraft(0),
				groupBy: [],
				addOns: { ...createQueryDraft(0).addOns, groupBy: false },
			},
		],
		funnel: {
			...defaultFunnelDraft(),
			source: "product_events",
			steps: [
				{ kind: "page", pagePath: "/pricing" },
				{ kind: "event", eventName: "signup_completed" },
			],
			keyBy: "visitor",
			windowSeconds: 3600,
		},
	})

	it("routes to the product_events_funnel route with the definition as params", () => {
		const dataSource = buildWidgetDataSource(makeWidget(), funnelState(), ["A"])
		expect(dataSource.kind).toBe("route")
		if (dataSource.kind !== "route") throw new Error("expected a route")
		expect(dataSource.endpoint).toBe("product_events_funnel")
		expect(dataSource.params).toEqual({
			steps: [
				{ kind: "page", pagePath: "/pricing" },
				{ kind: "event", eventName: "signup_completed" },
			],
			keyBy: "visitor",
			windowSeconds: 3600,
		})
	})

	it("compiles step filters, the population filter and the breakdown into the params", () => {
		const state: QueryBuilderWidgetState = {
			...funnelState(),
			funnel: {
				...funnelState().funnel,
				steps: [
					{ kind: "page", pagePath: "/pricing", host: "example.com" },
					{ kind: "event", eventName: "signup_completed", filterClause: 'plan = "pro" AND source = cli' },
				],
				filterClause: 'country = "DE" AND utm.source = "twitter"',
				breakdownBy: "referrerHost",
			},
		}
		const dataSource = buildWidgetDataSource(makeWidget(), state, ["A"])
		if (dataSource.kind !== "route") throw new Error("expected a route")
		expect(dataSource.params).toEqual({
			steps: [
				{ kind: "page", pagePath: "/pricing", host: "example.com" },
				{ kind: "event", eventName: "signup_completed", attributeEquals: { plan: "pro", source: "cli" } },
			],
			keyBy: "visitor",
			windowSeconds: 3600,
			breakdownBy: "referrerHost",
			country: "DE",
			utmSource: "twitter",
		})
	})

	it("stays a group-by breakdown on the query-set source, whatever the steps say", () => {
		const state: QueryBuilderWidgetState = {
			...funnelState(),
			funnel: { ...funnelState().funnel, source: "query_set" },
		}
		expect(routedTo(buildWidgetDataSource(makeWidget(), state, ["A"]))).toBe("breakdown")
	})

	it("persists the definition on display.funnel and reads it back", () => {
		const state: QueryBuilderWidgetState = {
			...funnelState(),
			funnel: {
				...funnelState().funnel,
				steps: [
					{ kind: "page", pagePath: "/pricing" },
					{ kind: "event", eventName: "signup_completed", filterClause: 'plan = "pro"' },
				],
				filterClause: 'country = "DE"',
				breakdownBy: "attribute:plan",
				showStepPercent: false,
			},
		}
		const widget = {
			...makeWidget(),
			visualization: "funnel" as const,
			display: { funnel: { showStepPercent: true } },
		}
		const display = buildWidgetDisplay(widget, state)
		expect(display.funnel).toEqual({
			showStepPercent: false,
			steps: [
				{ kind: "page", pagePath: "/pricing" },
				{ kind: "event", eventName: "signup_completed", attributeEquals: { plan: "pro" } },
			],
			keyBy: "visitor",
			windowSeconds: 3600,
			breakdownBy: "attribute:plan",
			filters: { country: "DE" },
		})

		const reopened = toInitialState({
			...widget,
			display,
			dataSource: buildWidgetDataSource(widget, state, ["A"]),
		})
		expect(reopened.funnel).toEqual({
			source: "product_events",
			steps: [
				{ kind: "page", pagePath: "/pricing" },
				{
					kind: "event",
					eventName: "signup_completed",
					attributeEquals: { plan: "pro" },
					filterClause: 'plan = "pro"',
				},
			],
			keyBy: "visitor",
			windowSeconds: 3600,
			breakdownBy: "attribute:plan",
			filterClause: 'country = "DE"',
			showStepPercent: false,
			addOns: { keyBy: true, window: true, breakdown: true },
		})
	})

	it("opens a widget stored with steps but no source field on the product-events source", () => {
		const widget = {
			...makeWidget(),
			visualization: "funnel" as const,
			display: { funnel: { steps: [{ kind: "event" as const, eventName: "x" }] } },
		}
		expect(toInitialState(widget).funnel).toMatchObject({
			source: "product_events",
			steps: [{ kind: "event", eventName: "x" }],
			addOns: { keyBy: false, window: false, breakdown: false },
		})
	})

	it("opens a product-events route widget without a display definition on its own params", () => {
		const widget = {
			...makeWidget(),
			visualization: "funnel" as const,
			display: {},
			dataSource: {
				kind: "route" as const,
				endpoint: "product_events_funnel",
				params: { steps: [{ kind: "page", pagePath: "/" }], keyBy: "session", country: "DE" },
			},
		}
		expect(toInitialState(widget).funnel).toMatchObject({
			source: "product_events",
			steps: [{ kind: "page", pagePath: "/" }],
			keyBy: "session",
			filterClause: 'country = "DE"',
		})
	})

	it("keeps only the rendering flag on the query-set source", () => {
		const state: QueryBuilderWidgetState = {
			...funnelState(),
			funnel: { ...defaultFunnelDraft(), showStepPercent: true },
		}
		const widget = {
			...makeWidget(),
			visualization: "funnel" as const,
			display: {
				funnel: { showStepPercent: true, steps: [{ kind: "event" as const, eventName: "x" }] },
			},
		}
		expect(buildWidgetDisplay(widget, state).funnel).toEqual({ showStepPercent: true })
	})

	it("skips the group-by requirement and validates the definition instead", () => {
		expect(validateQueries(funnelState())).toBeNull()
		const blank = {
			...funnelState(),
			funnel: { ...funnelState().funnel, steps: [{ kind: "event" as const, eventName: "" }] },
		}
		expect(validateQueries(blank)).toContain("Step 1 needs")
		const none = { ...funnelState(), funnel: { ...funnelState().funnel, steps: [] } }
		expect(validateQueries(none)).toBe("Add at least one step")
		const badStepFilter = {
			...funnelState(),
			funnel: {
				...funnelState().funnel,
				steps: [{ kind: "event" as const, eventName: "x", filterClause: "plan != pro" }],
			},
		}
		expect(validateQueries(badStepFilter)).toMatch(/^Step 1: /)
		const badFilter = { ...funnelState(), funnel: { ...funnelState().funnel, filterClause: 'plan = "pro"' } }
		expect(validateQueries(badFilter)).toMatch(/^Filters: /)
		// On the query-set source the ordinary rule is back: a funnel needs a group-by.
		const plain = { ...funnelState(), funnel: defaultFunnelDraft() }
		expect(validateQueries(plain)).toContain("group-by")
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

describe("heatmap palette default", () => {
	const heatmapWidget = (heatmap?: { colorScale?: "amber" | "blues"; scaleType?: "linear" }) => ({
		...makeWidget(),
		visualization: "heatmap" as const,
		display: heatmap === undefined ? {} : { heatmap },
	})

	it("leaves the palette unset when the widget never stored one", () => {
		expect(toInitialState(heatmapWidget()).heatmapColorScale).toBeUndefined()
	})

	it("does not materialise a palette on Apply for an untouched widget", () => {
		// The bug this guards: the rail seeded "blues" while the chart renders
		// amber, so opening a pre-`colorScale` heatmap and pressing Apply repainted
		// it blue without the user touching the palette control.
		const widget = heatmapWidget()
		const state = toInitialState(widget)
		const display = buildWidgetDisplay(widget, state)
		expect(display.heatmap?.colorScale).toBeUndefined()
		expect(display.heatmap?.scaleType).toBe("linear")
	})

	it("writes the palette once the user picks one", () => {
		const widget = heatmapWidget()
		const state = { ...toInitialState(widget), heatmapColorScale: "blues" as const }
		expect(buildWidgetDisplay(widget, state).heatmap?.colorScale).toBe("blues")
	})

	it("round-trips a stored palette", () => {
		const widget = heatmapWidget({ colorScale: "amber" })
		expect(buildWidgetDisplay(widget, toInitialState(widget)).heatmap?.colorScale).toBe("amber")
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
