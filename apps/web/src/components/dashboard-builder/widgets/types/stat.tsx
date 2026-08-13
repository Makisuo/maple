import { WIDGET_TYPES } from "@maple/domain/http"
import { dataSourceTransform } from "@maple/widgets/dashboard"

import { CirclePercentageIcon } from "@/components/icons"
import { WidgetSettings } from "@/components/dashboard-builder/config/settings-fields"
import { StatWidget } from "@/components/dashboard-builder/widgets/stat-widget"
import { statPresets } from "@/components/dashboard-builder/widgets/widget-definitions"
import {
	extendDisplay,
	type WidgetTypeDefinition,
} from "@/components/dashboard-builder/widgets/widget-type-registry"
import { toStatAggregate } from "@/lib/query-builder/widget-builder-shared"
import { PreviewFrame } from "@/components/dashboard-builder/widgets/types/preset-preview"
import { formatValue } from "@/components/dashboard-builder/widgets/stat-widget"
import type { WidgetPresetDefinition } from "@/components/dashboard-builder/widgets/widget-definitions"

/** Plausible readings, so the picker's tiles aren't all zero. */
const SAMPLE_VALUES: Record<string, number> = {
	"stat-total-traces": 48293,
	"stat-total-logs": 124817,
	"stat-error-rate": 0.032,
	"stat-total-errors": 1247,
	"stat-total-services": 12,
}

function StatPresetPreview({ preset }: { preset: WidgetPresetDefinition }) {
	const { display } = preset
	return (
		<PreviewFrame title={display.title} className="flex flex-col items-center justify-center gap-1.5">
			<div className="text-lg font-bold">
				{formatValue(SAMPLE_VALUES[preset.id] ?? 0, display.unit, display.prefix, display.suffix)}
			</div>
		</PreviewFrame>
	)
}

/** A scalar tile: the timeseries reduced to one number, optionally with a trend. */
export const statWidgetType: WidgetTypeDefinition = {
	meta: WIDGET_TYPES.stat,
	icon: CirclePercentageIcon,
	Renderer: StatWidget,
	queryEditor: "builder",
	ConfigPanel: () => (
		<>
			<WidgetSettings.Divider />
			<WidgetSettings.Unit />
			<WidgetSettings.ScalarReduction />
			<WidgetSettings.Sparkline />
			<WidgetSettings.Thresholds />
			<WidgetSettings.QueryOptions />
		</>
	),
	presets: statPresets,
	PresetPreview: StatPresetPreview,

	initialState: (widget) => ({
		statAggregate: toStatAggregate(dataSourceTransform(widget.dataSource)?.reduceToValue?.aggregate),
		statValueField: dataSourceTransform(widget.dataSource)?.reduceToValue?.field ?? "",
		sparklineEnabled: widget.display.sparkline?.enabled === true,
	}),

	buildDataSource: ({ base, state, sharedTransform, seriesFieldOptions }) => ({
		...base,
		transform: {
			...sharedTransform,
			reduceToValue: {
				field: state.statValueField || seriesFieldOptions[0] || "A",
				aggregate: state.statAggregate,
			},
		},
	}),

	buildDisplay: ({ base, state, timeseriesDataSource }) =>
		extendDisplay(base, {
			unit: state.unit,
			sparkline: state.sparklineEnabled
				? {
						enabled: true,
						// The sparkline is the stat's own query as a raw timeseries —
						// the same data source, minus the scalar `reduceToValue`.
						dataSource: timeseriesDataSource,
					}
				: undefined,
			thresholds: state.thresholds.length > 0 ? state.thresholds.map((t) => ({ ...t })) : undefined,
		}),
}
