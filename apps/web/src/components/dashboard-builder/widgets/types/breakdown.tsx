import { WIDGET_TYPES } from "@maple/domain/http"

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
import type { BuildDataSourceContext } from "@/lib/query-builder/widget-builder-shared"
import {
	hasActiveGroupBy,
	histogramValueColumn,
	parsePositiveNumber,
} from "@/lib/query-builder/widget-builder-shared"
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
	({
		endpoint: "custom_query_builder_breakdown",
		// Deliberately NOT forwarding `state.formulas`. A formula is a timeseries
		// expression with no meaning in a categorical breakdown, and
		// `QueryBuilderBreakdownInputSchema` (api/warehouse/query-builder-breakdown.ts)
		// accepts only startTime/endTime/queries — smuggling formulas through the
		// params to preserve them across a reopen fails the request decode and
		// leaves the widget stuck on its loading skeleton.
		params: {
			queries: visibleQueries,
			...(options?.defaultLimit ? { defaultLimit: options.defaultLimit } : {}),
		},
		transform: sharedTransform,
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

export const funnelWidgetType: WidgetTypeDefinition = {
	meta: WIDGET_TYPES.funnel,
	// A funnel is a descending series of stages.
	icon: ArrowTrendDownIcon,
	Renderer: FunnelWidget,
	queryEditor: "builder",
	ConfigPanel: () => <WidgetSettings.QueryOptions />,
	presets: funnelPresets,
	PresetPreview: chartPresetPreview("query-builder-funnel"),
	buildDataSource: breakdownDataSource,
	buildDisplay: ({ base }) => base,
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
		heatmapColorScale: widget.display.heatmap?.colorScale ?? "blues",
		heatmapScaleType: widget.display.heatmap?.scaleType ?? "linear",
	}),

	buildDataSource: breakdownDataSource,
	buildDisplay: ({ base, state }) =>
		extendDisplay(base, {
			heatmap: { colorScale: state.heatmapColorScale, scaleType: state.heatmapScaleType },
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
		return {
			endpoint: "custom_query_builder_list",
			params: {
				queries: ctx.visibleQueries,
				limit: parsePositiveNumber(ctx.state.tableLimit) ?? 200,
				...(valueColumn ? { columns: [valueColumn] } : {}),
			},
			transform: ctx.sharedTransform,
		}
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
