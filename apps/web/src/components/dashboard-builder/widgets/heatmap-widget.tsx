import { memo, Suspense } from "react"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { getChartById } from "@maple/ui/components/charts/registry"
import { WidgetFrame } from "@/components/dashboard-builder/widgets/widget-shell"
import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"

interface HeatmapWidgetProps {
	dataState: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
	onRemove: () => void
	onClone?: () => void
	onConfigure?: () => void
}

export const HeatmapWidget = memo(function HeatmapWidget({
	dataState,
	display,
	mode,
	onRemove,
	onClone,
	onConfigure,
}: HeatmapWidgetProps) {
	const entry = getChartById(display.chartId ?? "query-builder-heatmap")
	if (!entry) return null

	const ChartComponent = entry.component
	const chartData =
		dataState.status === "ready" && Array.isArray(dataState.data) ? dataState.data : undefined
	const tooltip = display.chartPresentation?.tooltip

	return (
		<WidgetFrame
			title={display.title || "Untitled"}
			dataState={dataState}
			mode={mode}
			onRemove={onRemove}
			onClone={onClone}
			onConfigure={onConfigure}
			loadingSkeleton={<Skeleton className="h-full w-full" />}
		>
			<Suspense fallback={<Skeleton className="h-full w-full" />}>
				<ChartComponent
					data={chartData}
					className="h-full w-full"
					tooltip={tooltip}
					unit={display.unit}
					heatmap={display.heatmap}
				/>
			</Suspense>
		</WidgetFrame>
	)
})
