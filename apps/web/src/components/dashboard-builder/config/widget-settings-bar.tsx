import { SettingsSourceMode, WidgetSettings } from "@/components/dashboard-builder/config/settings-fields"
import { widgetTypes } from "@/components/dashboard-builder/widgets/types"
import { useWidgetBuilder } from "@/hooks/use-widget-builder"
import { toPanelType } from "@/lib/query-builder/panel-types"

export type { LegendPosition } from "@/components/dashboard-builder/config/settings-fields"

/**
 * The "Panel Options" rail.
 *
 * Name, description and the type picker are the same for every widget; below
 * them the selected panel type renders its own fields. This used to be one
 * 592-line form whose every section was gated on `isChart`/`isStat`/`isGauge`/…
 * — nine booleans that a tenth widget type would have had to thread through by
 * hand.
 */
export function WidgetSettingsBar({ sourceMode = "builder" }: { sourceMode?: "builder" | "rawSql" }) {
	const { state } = useWidgetBuilder()
	const { ConfigPanel } = widgetTypes[toPanelType(state.visualization, state.chartId)]

	return (
		<SettingsSourceMode mode={sourceMode}>
			<div className="flex flex-col gap-5">
				<p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
					Panel Options
				</p>
				<WidgetSettings.Name />
				<WidgetSettings.Description />
				<WidgetSettings.TimeRange />
				<WidgetSettings.Divider />
				<WidgetSettings.TypePicker />
				<ConfigPanel />
			</div>
		</SettingsSourceMode>
	)
}
