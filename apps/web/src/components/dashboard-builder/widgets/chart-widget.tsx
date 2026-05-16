import { memo, Suspense } from "react"

import { getChartById } from "@maple/ui/components/charts/registry"
import { ChartSkeleton } from "@maple/ui/components/charts/_shared/chart-skeleton"
import { WidgetFrame } from "@/components/dashboard-builder/widgets/widget-shell"
import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"

interface ChartWidgetProps {
	dataState: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
	onRemove: () => void
	onClone?: () => void
	onConfigure?: () => void
	onCreateAlert?: () => void
	onFix?: () => void
}

export const ChartWidget = memo(function ChartWidget({
	dataState,
	display,
	mode,
	onRemove,
	onClone,
	onConfigure,
	onCreateAlert,
	onFix,
}: ChartWidgetProps) {
	const chartId = display.chartId ?? "gradient-area"
	const entry = getChartById(chartId)
	if (!entry) return null

	const ChartComponent = entry.component
	const chartData =
		dataState.status === "ready" && Array.isArray(dataState.data) ? dataState.data : undefined
	const legend = display.chartPresentation?.legend ?? "hidden"
	const seriesStats = display.chartPresentation?.seriesStats ?? legend !== "hidden"
	const tooltip = display.chartPresentation?.tooltip

	return (
		<WidgetFrame
			title={display.title || "Untitled"}
			dataState={dataState}
			mode={mode}
			onRemove={onRemove}
			onClone={onClone}
			onConfigure={onConfigure}
			onCreateAlert={onCreateAlert}
			onFix={onFix}
			loadingSkeleton={<ChartSkeleton variant={entry.category} />}
		>
			<Suspense fallback={<ChartSkeleton variant={entry.category} />}>
				<ChartComponent
					data={chartData}
					className="h-full w-full aspect-auto"
					legend={legend}
					seriesStats={seriesStats}
					tooltip={tooltip}
					stacked={display.stacked}
					curveType={display.curveType}
					unit={display.unit}
					logScale={display.yAxis?.logScale}
					softMin={display.yAxis?.softMin}
					softMax={display.yAxis?.softMax}
					showPoints={display.chartPresentation?.showPoints}
					thresholds={display.thresholds}
				/>
			</Suspense>
		</WidgetFrame>
	)
})
