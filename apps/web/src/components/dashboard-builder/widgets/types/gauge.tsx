import { WIDGET_TYPES } from "@maple/domain/http"

import { SlidersIcon } from "@/components/icons"
import { WidgetSettings } from "@/components/dashboard-builder/config/settings-fields"
import { GaugeWidget } from "@/components/dashboard-builder/widgets/gauge-widget"
import {
	extendDisplay,
	type WidgetTypeDefinition,
} from "@/components/dashboard-builder/widgets/widget-type-registry"
import { parseFiniteNumber, toStatAggregate } from "@/lib/query-builder/widget-builder-shared"

/** A scalar on an arc — the same reduction as a stat, plus a range to sweep. */
export const gaugeWidgetType: WidgetTypeDefinition = {
	meta: WIDGET_TYPES.gauge,
	icon: SlidersIcon,
	Renderer: GaugeWidget,
	queryEditor: "builder",
	ConfigPanel: () => (
		<>
			<WidgetSettings.Divider />
			<WidgetSettings.Unit />
			<WidgetSettings.ScalarReduction />
			<WidgetSettings.GaugeRange />
			<WidgetSettings.Thresholds />
			<WidgetSettings.QueryOptions />
		</>
	),
	presets: [],

	initialState: (widget) => ({
		statAggregate: toStatAggregate(widget.dataSource.transform?.reduceToValue?.aggregate),
		statValueField: widget.dataSource.transform?.reduceToValue?.field ?? "",
		gaugeMin: widget.display.gauge?.min != null ? String(widget.display.gauge.min) : "",
		gaugeMax: widget.display.gauge?.max != null ? String(widget.display.gauge.max) : "",
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

	buildDisplay: ({ base, state }) =>
		extendDisplay(base, {
			unit: state.unit,
			gauge: {
				min: parseFiniteNumber(state.gaugeMin) ?? 0,
				max: parseFiniteNumber(state.gaugeMax) ?? 100,
			},
			thresholds: state.thresholds.length > 0 ? state.thresholds.map((t) => ({ ...t })) : undefined,
		}),
}
