import { describe, expect, it } from "vitest"
import { PANEL_TYPES, type PanelType } from "@maple/domain/http"
import { createQueryDraft } from "@maple/query-engine/query-builder"
import { fromPanelType, toPanelType } from "@/lib/query-builder/panel-types"
import { widgetTypes } from "@/components/dashboard-builder/widgets/types"
import {
	buildWidgetDataSource,
	buildWidgetDisplay,
	toInitialState,
	validateQueries,
	type QueryBuilderWidgetState,
} from "@/lib/query-builder/widget-builder-utils"
import type { DashboardWidget } from "@/components/dashboard-builder/types"

/**
 * What a widget routed to, as one comparable value.
 *
 * v2 answered this with an endpoint string; v3 answers it with `kind` plus, for
 * queries, `resultShape`. Collapsing them back into a single token keeps these
 * routing assertions reading as routing assertions rather than as narrowing.
 */
const routedTo = (dataSource: DashboardWidget["dataSource"]): string =>
	dataSource.kind === "query" ? dataSource.resultShape : dataSource.kind

// Switching a widget's panel type, exhaustively.
//
// The editor's Type picker lets any widget become any other, and the lowering
// used to be four hand-maintained if-chains — so a type could keep a display key
// it no longer owns (a Line switched to Pie kept `chartId: "query-builder-line"`
// and rendered a line chart over breakdown rows) or lower to the wrong endpoint.
// These walk every panel type through save → reopen → save and pin the
// invariants that were only ever checked by clicking.

const ALL_PANELS: PanelType[] = PANEL_TYPES.map((meta) => meta.panelType)

function groupedQuery() {
	const draft = createQueryDraft(0)
	return {
		...draft,
		dataSource: "traces" as const,
		addOns: { ...draft.addOns, groupBy: true },
		groupBy: ["service.name"],
	}
}

/** A draft with the group-by add-on explicitly off. */
function ungroupedQuery(dataSource: "traces" | "logs" = "traces") {
	const draft = createQueryDraft(0)
	return {
		...draft,
		dataSource,
		// Logs only support `count`; anything else fails the shared query-spec
		// check before the per-type rule is reached.
		aggregation: dataSource === "logs" ? "count" : draft.aggregation,
		addOns: { ...draft.addOns, groupBy: false },
	}
}

function makeState(overrides: Partial<QueryBuilderWidgetState> = {}): QueryBuilderWidgetState {
	return {
		visualization: "chart",
		title: "",
		description: "",
		timeRange: null,
		chartId: "query-builder-line",
		stacked: false,
		curveType: "linear",
		queries: [groupedQuery()],
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
		funnel: { steps: [], keyBy: "person", windowSeconds: 86400 },
		...overrides,
	}
}

function makeWidget(overrides: Partial<DashboardWidget> = {}): DashboardWidget {
	return {
		id: "widget-1",
		visualization: "chart",
		dataSource: { kind: "query", resultShape: "timeseries", queries: [] },
		display: {},
		layout: { x: 0, y: 0, w: 6, h: 4 },
		...overrides,
	}
}

/** Save the editor state onto a widget, the way the Apply button does. */
function apply(widget: DashboardWidget, state: QueryBuilderWidgetState): DashboardWidget {
	return {
		...widget,
		visualization: state.visualization,
		dataSource: buildWidgetDataSource(widget, state, ["A"]),
		display: buildWidgetDisplay(widget, state),
	}
}

/** Pick panel type `panel` in the Type picker. */
function selectPanel(state: QueryBuilderWidgetState, panel: PanelType): QueryBuilderWidgetState {
	const { visualization, chartId } = fromPanelType(panel, state.chartId)
	// The editor state always carries a chartId; the types with no chart of their
	// own just never read it. Keeping the previous one mirrors the real picker.
	return { ...state, visualization, chartId: chartId ?? state.chartId }
}

describe("switching panel type", () => {
	it("covers every panel type in the registry", () => {
		expect(ALL_PANELS).toHaveLength(13)
		expect(Object.keys(widgetTypes).sort()).toEqual([...ALL_PANELS].sort())
	})

	it("round-trips each type through save and reopen", () => {
		for (const panel of ALL_PANELS) {
			const saved = apply(makeWidget(), selectPanel(makeState(), panel))
			// Reopening must report the same panel type it was saved as, or the
			// settings rail and the canvas disagree about what the widget is.
			expect(toPanelType(saved.visualization, saved.display.chartId), panel).toBe(panel)

			const reopened = toInitialState(saved)
			expect(toPanelType(reopened.visualization, reopened.chartId), panel).toBe(panel)
		}
	})

	it("never carries a foreign chartId across a switch", () => {
		// Every ordered pair, so a type that leaks a key is caught wherever it
		// leaks from — the original bug only showed up going line → pie.
		for (const from of ALL_PANELS) {
			for (const to of ALL_PANELS) {
				const first = apply(makeWidget(), selectPanel(makeState(), from))
				const second = apply(first, selectPanel(toInitialState(first), to))

				const expected = widgetTypes[to].meta.chartId
				expect(second.display.chartId, `${from} → ${to}`).toBe(expected)
				expect(second.visualization, `${from} → ${to}`).toBe(widgetTypes[to].meta.visualization)
			}
		}
	})

	it("never leaves a display key owned by the type it came from", () => {
		for (const from of ALL_PANELS) {
			for (const to of ALL_PANELS) {
				const first = apply(makeWidget(), selectPanel(makeState({ stacked: true }), from))
				const second = apply(first, selectPanel(toInitialState(first), to))

				const ownedByTarget = new Set<string>(widgetTypes[to].meta.ownedDisplayKeys)
				const leaked = widgetTypes[from].meta.ownedDisplayKeys.filter(
					(key) => !ownedByTarget.has(key) && second.display[key] !== undefined,
				)
				expect(leaked, `${from} → ${to} leaked ${leaked.join(", ")}`).toEqual([])
			}
		}
	})
})

describe("endpoint routing", () => {
	it("sends the categorical types to the breakdown endpoint", () => {
		for (const panel of ["pie", "funnel", "heatmap", "hbar"] as const) {
			const source = buildWidgetDataSource(makeWidget(), selectPanel(makeState(), panel), ["A"])
			expect(routedTo(source), panel).toBe("breakdown")
			// A formula is a timeseries expression; the breakdown input schema
			// rejects it, and the widget then hangs on its loading skeleton.
			if (source.kind !== "query") throw new Error("expected a query data source")
			expect(source.formulas, panel).toBeUndefined()
		}
	})

	it("routes an ungrouped histogram to the list endpoint, not the breakdown", () => {
		// MAP-49: a count-by-group breakdown is not a duration distribution. This
		// is the one type whose endpoint depends on its queries, not just its kind.
		const ungrouped = makeState({ queries: [ungroupedQuery()] })
		const listSource = buildWidgetDataSource(makeWidget(), selectPanel(ungrouped, "histogram"), ["A"])
		expect(routedTo(listSource)).toBe("list")
		if (listSource.kind !== "query") throw new Error("expected a query data source")
		expect(listSource.columns).toEqual(["durationMs"])

		const grouped = buildWidgetDataSource(makeWidget(), selectPanel(makeState(), "histogram"), ["A"])
		expect(routedTo(grouped)).toBe("breakdown")
	})

	it("gives a note no query at all", () => {
		const source = buildWidgetDataSource(makeWidget(), selectPanel(makeState(), "markdown"), ["A"])
		expect(source).toEqual({ kind: "static" })
	})

	it("reduces stat and gauge to a scalar", () => {
		for (const panel of ["stat", "gauge"] as const) {
			const source = buildWidgetDataSource(
				makeWidget(),
				selectPanel(makeState({ statValueField: "A", statAggregate: "avg" }), panel),
				["A"],
			)
			expect(source.transform?.reduceToValue, panel).toEqual({ field: "A", aggregate: "avg" })
		}
	})
})

describe("stat sparkline", () => {
	it("nests the stat's own query without the scalar reduction", () => {
		const state = selectPanel(makeState({ sparklineEnabled: true }), "stat")
		const display = buildWidgetDisplay(makeWidget(), state)

		expect(display.sparkline?.enabled).toBe(true)
		const nested = display.sparkline?.dataSource
		expect(nested === undefined ? undefined : routedTo(nested)).toBe("timeseries")
		// The sparkline is a trend, so it must NOT carry the stat's reduction.
		expect(nested?.transform?.reduceToValue).toBeUndefined()
	})

	it("drops the nested source when the sparkline is switched off", () => {
		const on = apply(makeWidget(), selectPanel(makeState({ sparklineEnabled: true }), "stat"))
		const off = apply(on, selectPanel(makeState({ sparklineEnabled: false }), "stat"))
		expect(off.display.sparkline).toBeUndefined()
	})
})

describe("validation", () => {
	it("requires a group-by for the categorical types", () => {
		const ungrouped = makeState({ queries: [ungroupedQuery()] })
		for (const panel of ["pie", "funnel", "heatmap", "hbar"] as const) {
			expect(validateQueries(selectPanel(ungrouped, panel))).toMatch(/group-by/)
			expect(validateQueries(selectPanel(makeState(), panel)), panel).toBeNull()
		}
	})

	it("lets an ungrouped trace histogram through but not an ungrouped log one", () => {
		const traces = makeState({ queries: [ungroupedQuery()] })
		expect(validateQueries(selectPanel(traces, "histogram"))).toBeNull()

		const logs = makeState({ queries: [ungroupedQuery("logs")] })
		expect(validateQueries(selectPanel(logs, "histogram"))).toMatch(/group-by/)
	})

	it("never blocks Apply on the types with no query builder", () => {
		// Their placeholder draft is not something the user can fix.
		for (const panel of ["list", "markdown"] as const) {
			const state = selectPanel(makeState({ queries: [] }), panel)
			expect(validateQueries(state), panel).toBeNull()
		}
	})
})
