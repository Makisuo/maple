import { WIDGET_TYPES } from "@maple/domain/http"

import { ChartBarIcon, ChartBarTrendUpIcon, ChartLineIcon } from "@/components/icons"
import { WidgetSettings } from "@/components/dashboard-builder/config/settings-fields"
import { ChartWidget } from "@/components/dashboard-builder/widgets/make-chart-widget"
import {
	extendDisplay,
	type WidgetTypeDefinition,
} from "@/components/dashboard-builder/widgets/widget-type-registry"

// Line, bar and area. All three persist as `visualization: "chart"` and differ
// only in `display.chartId`, so they share a renderer and a data source; the
// settings rail is where they diverge — a curve is meaningless on a bar, and
// stacking is meaningless on a line.

function TimeSeriesSettings({ stacked, curve }: { stacked: boolean; curve: boolean }) {
	return (
		<>
			{stacked && <WidgetSettings.Stacked />}
			{curve && <WidgetSettings.Curve />}
			{curve && <WidgetSettings.Points />}
			<WidgetSettings.Divider />
			<WidgetSettings.Unit label="Y-Axis Unit" />
			<WidgetSettings.Legend />
			<WidgetSettings.Thresholds />
			<WidgetSettings.QueryOptions />
		</>
	)
}

const chartType = (
	panelType: "line" | "bar" | "area",
	icon: WidgetTypeDefinition["icon"],
	ConfigPanel: WidgetTypeDefinition["ConfigPanel"],
): WidgetTypeDefinition => ({
	meta: WIDGET_TYPES[panelType],
	icon,
	Renderer: ChartWidget,
	queryEditor: "builder",
	ConfigPanel,
	// Line/bar/area presets are generated from the chart registry by the picker,
	// not hand-written, so there is nothing to list here.
	presets: [],
	// A timeseries is exactly the shared base — no reduction, no reshaping.
	buildDataSource: ({ base }) => base,
	buildDisplay: ({ base, state }) =>
		extendDisplay(base, {
			stacked: state.stacked,
			curveType: state.curveType,
			unit: state.unit,
			thresholds: state.thresholds.length > 0 ? state.thresholds.map((t) => ({ ...t })) : undefined,
		}),
})

export const lineWidgetType = chartType("line", ChartLineIcon, () => (
	<TimeSeriesSettings stacked={false} curve />
))

export const barWidgetType = chartType("bar", ChartBarIcon, () => (
	<TimeSeriesSettings stacked curve={false} />
))

export const areaWidgetType = chartType("area", ChartBarTrendUpIcon, () => (
	<TimeSeriesSettings stacked curve />
))
