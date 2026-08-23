import { Option, Schema } from "effect"
import { WIDGET_TYPES } from "@maple/domain/http"
import { ProductEventsFunnelWidgetParams } from "@maple/query-model"
import {
	PRODUCT_EVENTS_FUNNEL_ENDPOINT,
	dataSourceEndpoint,
	dataSourceRouteParams,
	makeProductEventsFunnelDataSource,
	makeQueryDataSource,
	type ProductEventsFunnelDefinition,
} from "@maple/widgets/dashboard"

import {
	ArrowTrendDownIcon,
	ChartBarHorizontalIcon,
	ChartBarIcon,
	CirclePercentageIcon,
	LayersIcon,
} from "@/components/icons"
import { WidgetSettings } from "@/components/dashboard-builder/config/settings-fields"
import {
	FunnelWidget,
	HbarWidget,
	HeatmapWidget,
	HistogramWidget,
	PieWidget,
} from "@/components/dashboard-builder/widgets/make-chart-widget"
import {
	funnelPresets,
	hbarPresets,
	heatmapPresets,
	histogramPresets,
	piePresets,
} from "@/components/dashboard-builder/widgets/widget-definitions"
import {
	extendDisplay,
	type WidgetTypeDefinition,
} from "@/components/dashboard-builder/widgets/widget-type-registry"
import { BREAKDOWN_TAIL_LIMIT } from "@maple/query-engine/query-builder"
import type { BuildDataSourceContext, FunnelWidgetDraft } from "@/lib/query-builder/widget-builder-shared"
import {
	hasActiveGroupBy,
	histogramValueColumn,
	isProductEventsFunnel,
	parsePositiveNumber,
} from "@/lib/query-builder/widget-builder-shared"
import {
	compileFunnelStep,
	compileFunnelSteps,
	draftFromFunnelStep,
	formatProductEventsFilterClause,
	hasProductEventsFilters,
	parseProductEventsFilterClause,
} from "@/lib/query-builder/funnel-filters"
import {
	DEFAULT_FUNNEL_KEY_BY,
	DEFAULT_FUNNEL_WINDOW_SECONDS,
	completedSteps,
} from "@/components/funnels/definition"
import type { WidgetDataSource } from "@/components/dashboard-builder/types"
import { chartPresetPreview } from "@/components/dashboard-builder/widgets/types/preset-preview"

// Categorical charts: pie, histogram, heatmap, funnel, horizontal bar.
//
// They read one row per category from the breakdown endpoint, not one row per
// time bucket from the timeseries endpoint. Sending them to the wrong endpoint
// is silent — the widget renders one slice per bucket with uniform values and no
// labels — which is why the group-by requirement is declared on the type
// (`meta.requiresGroupBy`) and enforced before Apply.

const breakdownDataSource = (
	{ sharedTransform, visibleQueries }: BuildDataSourceContext,
	// Only the pie collapses its long tail into an "Other" slice, so only the pie
	// asks for rows past what it draws. Funnel/heatmap/histogram plot every row
	// they receive — handing them 50 turns a 10-stage funnel into a truncated list.
	options?: { defaultLimit?: number },
) =>
	makeQueryDataSource({
		resultShape: "breakdown",
		// Deliberately NOT forwarding `state.formulas`. A formula is a timeseries
		// expression with no meaning in a categorical breakdown, and
		// `QueryBuilderBreakdownInputSchema` (api/warehouse/query-builder-breakdown.ts)
		// accepts only startTime/endTime/queries — smuggling formulas through to
		// preserve them across a reopen fails the request decode and leaves the
		// widget stuck on its loading skeleton.
		queries: visibleQueries,
		...(options?.defaultLimit ? { defaultLimit: options.defaultLimit } : undefined),
		...(!(sharedTransform === undefined) ? { transform: sharedTransform } : undefined),
	}) satisfies WidgetDataSource

export const pieWidgetType: WidgetTypeDefinition = {
	meta: WIDGET_TYPES.pie,
	icon: CirclePercentageIcon,
	Renderer: PieWidget,
	queryEditor: "builder",
	// "Right" renders the sorted Value/% table — the standard reading of a
	// composition breakdown, and the reason the legend is configurable here at all.
	ConfigPanel: () => (
		<>
			<WidgetSettings.Divider />
			<WidgetSettings.Legend seriesStats={false} />
			<WidgetSettings.QueryOptions />
		</>
	),
	presets: piePresets,
	PresetPreview: chartPresetPreview("query-builder-pie"),
	buildDataSource: (ctx) => breakdownDataSource(ctx, { defaultLimit: BREAKDOWN_TAIL_LIMIT }),
	buildDisplay: ({ base }) => base,
}

/**
 * The funnel widget has one visualization and two sources, chosen in its query
 * panel. "Product events" is a conversion funnel over `product_events`
 * (`display.funnel.steps` + key, window, filters, breakdown), fetched through
 * the `product_events_funnel` route; a query-builder source is the original
 * group-by breakdown drawn as descending stages. Same renderer, same
 * `{ name, value }` rows (plus `group` on a breakdown). The definition is
 * persisted on the display block — additive, so older readers of the document
 * see a funnel with extra keys they ignore — and mirrored into the route params
 * so the fetch path never has to read the display.
 */
export const funnelWidgetType: WidgetTypeDefinition = {
	meta: WIDGET_TYPES.funnel,
	// A funnel is a descending series of stages.
	icon: ArrowTrendDownIcon,
	Renderer: FunnelWidget,
	queryEditor: "builder",
	ConfigPanel: () => (
		<>
			<WidgetSettings.Divider />
			<WidgetSettings.FunnelStepPercent />
			<WidgetSettings.QueryOptions />
		</>
	),
	presets: funnelPresets,
	PresetPreview: chartPresetPreview("query-builder-funnel"),

	initialState: (widget) => {
		const stored = widget.display.funnel
		// The display is the definition's home; a widget whose route was written
		// without one (an older MCP call) still opens on its own steps.
		const routeParams =
			dataSourceEndpoint(widget.dataSource) === PRODUCT_EVENTS_FUNNEL_ENDPOINT
				? Option.getOrUndefined(
						Schema.decodeUnknownOption(ProductEventsFunnelWidgetParams)(
							dataSourceRouteParams(widget.dataSource) ?? {},
						),
					)
				: undefined
		const steps = stored?.steps ?? routeParams?.steps ?? []
		const keyBy = stored?.keyBy ?? routeParams?.keyBy ?? DEFAULT_FUNNEL_KEY_BY
		const windowSeconds = stored?.windowSeconds ?? routeParams?.windowSeconds ?? DEFAULT_FUNNEL_WINDOW_SECONDS
		const breakdownBy = stored?.breakdownBy ?? routeParams?.breakdownBy
		const filterClause = formatProductEventsFilterClause(stored?.filters ?? routeParams)
		const funnel: FunnelWidgetDraft = {
			source: routeParams !== undefined || steps.length > 0 ? "product_events" : "query_set",
			steps: steps.map(draftFromFunnelStep),
			keyBy,
			windowSeconds,
			...(breakdownBy !== undefined ? { breakdownBy } : undefined),
			filterClause,
			showStepPercent: stored?.showStepPercent,
			// An add-on is open when its value is not the default, so the bar shows
			// what is set without hiding a stored choice.
			addOns: {
				keyBy: keyBy !== DEFAULT_FUNNEL_KEY_BY,
				window: windowSeconds !== DEFAULT_FUNNEL_WINDOW_SECONDS,
				breakdown: breakdownBy !== undefined,
			},
		}
		return { funnel }
	},

	ownsDataSource: isProductEventsFunnel,

	buildDataSource: (ctx) =>
		isProductEventsFunnel(ctx.state)
			? makeProductEventsFunnelDataSource(funnelDefinition(ctx.state.funnel), ctx.sharedTransform)
			: breakdownDataSource(ctx),

	buildDisplay: ({ base, state }) =>
		extendDisplay(base, {
			funnel: isProductEventsFunnel(state)
				? {
						...(state.funnel.showStepPercent !== undefined
							? { showStepPercent: state.funnel.showStepPercent }
							: undefined),
						...funnelDefinition(state.funnel),
						steps: [...funnelDefinition(state.funnel).steps],
					}
				: // A query-set funnel keeps only the rendering flag.
					state.funnel.showStepPercent !== undefined
					? { showStepPercent: state.funnel.showStepPercent }
					: undefined,
		}),

	validate: ({ state }) => {
		if (!isProductEventsFunnel(state)) return null
		const { steps, filterClause, windowSeconds } = state.funnel
		if (steps.length === 0) return "Add at least one step"
		const incomplete = steps.findIndex((step) => completedSteps([step]).length === 0)
		if (incomplete !== -1) return `Step ${incomplete + 1} needs an event name, page path or session value`
		if (steps.some((step, index) => index > 0 && step.kind === "session")) {
			return "A session step is only valid as step 1"
		}
		const compiled = compileFunnelSteps(steps)
		if (!compiled.ok) return compiled.error
		const filters = parseProductEventsFilterClause(filterClause)
		if (!filters.ok) return `Filters: ${filters.error}`
		if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return "The conversion window must be positive"
		return null
	},
}

/**
 * The draft lowered to the stored / routed definition. A step whose filter
 * does not compile falls back to the bare step, and an unparsable population
 * filter to none — `validate` blocks Apply and Run Preview on both, so this is
 * only reached for a definition that passed.
 */
function funnelDefinition(funnel: FunnelWidgetDraft): ProductEventsFunnelDefinition {
	const steps = funnel.steps.map((draft) => {
		const compiled = compileFunnelStep(draft)
		if (compiled.ok) return compiled.value
		const { filterClause: _clause, ...step } = draft
		return step
	})
	const parsedFilters = parseProductEventsFilterClause(funnel.filterClause)
	const filters = parsedFilters.ok && hasProductEventsFilters(parsedFilters.value) ? parsedFilters.value : undefined
	return {
		steps,
		keyBy: funnel.keyBy,
		windowSeconds: funnel.windowSeconds,
		...(funnel.breakdownBy !== undefined ? { breakdownBy: funnel.breakdownBy } : undefined),
		...(filters !== undefined ? { filters } : undefined),
	}
}

/**
 * The ranked "top N by volume" panel, and the one a funnel was standing in for.
 * Same breakdown rows as a funnel; the difference is in the reading — sorted by
 * value, each row a share of the total rather than of the biggest row.
 */
export const hbarWidgetType: WidgetTypeDefinition = {
	meta: WIDGET_TYPES.hbar,
	icon: ChartBarHorizontalIcon,
	Renderer: HbarWidget,
	queryEditor: "builder",
	ConfigPanel: () => <WidgetSettings.QueryOptions />,
	presets: hbarPresets,
	PresetPreview: chartPresetPreview("query-builder-hbar"),
	buildDataSource: breakdownDataSource,
	buildDisplay: ({ base }) => base,
}

export const heatmapWidgetType: WidgetTypeDefinition = {
	meta: WIDGET_TYPES.heatmap,
	icon: LayersIcon,
	Renderer: HeatmapWidget,
	queryEditor: "builder",
	ConfigPanel: () => (
		<>
			<WidgetSettings.Divider />
			<WidgetSettings.HeatmapColors />
			<WidgetSettings.QueryOptions />
		</>
	),
	presets: heatmapPresets,
	PresetPreview: chartPresetPreview("query-builder-heatmap"),

	initialState: (widget) => ({
		heatmapColorScale: widget.display.heatmap?.colorScale,
		heatmapScaleType: widget.display.heatmap?.scaleType ?? "linear",
	}),

	buildDataSource: breakdownDataSource,
	// `colorScale` is written only once the user has actually picked a ramp:
	// a widget saved before the setting existed renders in
	// `DEFAULT_HEATMAP_COLOR_SCALE`, and Apply must not materialise a different
	// palette behind their back.
	buildDisplay: ({ base, state }) =>
		extendDisplay(base, {
			heatmap: {
				...(state.heatmapColorScale === undefined
					? undefined
					: { colorScale: state.heatmapColorScale }),
				scaleType: state.heatmapScaleType,
			},
		}),
}

/**
 * A histogram is a *distribution*, so it has two legitimate shapes. Grouped, it
 * is pre-bucketed `{name, value}` breakdown rows (one bar per group). Ungrouped,
 * it is raw per-row values that the chart bucketizes client-side — which needs
 * the list endpoint, because a count-by-group breakdown is not a duration
 * distribution (MAP-49). Routing every histogram to `breakdown` silently
 * converted the second kind into the first on Apply.
 */
export const histogramWidgetType: WidgetTypeDefinition = {
	meta: WIDGET_TYPES.histogram,
	icon: ChartBarIcon,
	Renderer: HistogramWidget,
	queryEditor: "builder",
	ConfigPanel: () => <WidgetSettings.QueryOptions />,
	presets: histogramPresets,
	PresetPreview: chartPresetPreview("query-builder-histogram"),

	buildDataSource: (ctx) => {
		if (ctx.visibleQueries.some(hasActiveGroupBy)) return breakdownDataSource(ctx)

		const valueColumn = histogramValueColumn(ctx.visibleQueries[0]?.dataSource ?? "traces")
		return makeQueryDataSource({
			resultShape: "list",
			queries: ctx.visibleQueries,
			limit: parsePositiveNumber(ctx.state.tableLimit) ?? 200,
			...(valueColumn ? { columns: [valueColumn] } : undefined),
			...(!(ctx.sharedTransform === undefined) ? { transform: ctx.sharedTransform } : undefined),
		})
	},

	buildDisplay: ({ base }) => base,

	// The ungrouped shape bucketizes a numeric column client-side, and only
	// traces have one — an ungrouped logs or metrics histogram renders nothing.
	validate: ({ visibleQueries }) => {
		if (visibleQueries.some(hasActiveGroupBy)) return null
		const unsupported = visibleQueries.find((query) => !histogramValueColumn(query.dataSource))
		return unsupported
			? `${unsupported.name}: a ${unsupported.dataSource} histogram needs a group-by field`
			: null
	},
}
