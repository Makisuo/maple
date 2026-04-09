import type { DashboardWidget, WidgetTimeRange } from "../../lib/api"
import { useWidgetData } from "../../hooks/use-widget-data"
import { ChartCard } from "../services/chart-card"
import { BreakdownBars } from "./breakdown-bars"
import { StatTile } from "./stat-tile"
import { TimeseriesChart } from "./timeseries-chart"
import { WidgetPlaceholder } from "./widget-placeholder"

interface DashboardWidgetViewProps {
	widget: DashboardWidget
	timeRange: WidgetTimeRange
	compact?: boolean
}

export function DashboardWidgetView({
	widget,
	timeRange,
	compact = false,
}: DashboardWidgetViewProps) {
	const state = useWidgetData(widget, timeRange)
	const title = widget.display.title ?? widget.id

	let body: React.ReactNode
	if (state.status === "loading") {
		body = <WidgetPlaceholder kind="loading" />
	} else if (state.status === "error") {
		body = <WidgetPlaceholder kind="error" message={state.error} />
	} else if (state.status === "unsupported") {
		body = <WidgetPlaceholder kind="unsupported" message={state.reason} />
	} else if (state.data.kind === "stat") {
		body = (
			<StatTile
				value={state.data.value}
				display={widget.display}
				compact={compact}
			/>
		)
	} else if (state.data.kind === "timeseries") {
		body = (
			<TimeseriesChart
				points={state.data.points}
				colorOverrides={widget.display.colorOverrides}
			/>
		)
	} else if (state.data.kind === "breakdown") {
		body = (
			<BreakdownBars
				items={state.data.items}
				colorOverrides={widget.display.colorOverrides}
			/>
		)
	}

	return (
		<ChartCard title={title} summary={null}>
			{body}
		</ChartCard>
	)
}
