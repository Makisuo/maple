import { memo, Suspense } from "react"

import { getChartById } from "@maple/ui/components/charts/registry"
import { ChartSkeleton } from "@maple/ui/components/charts/_shared/chart-skeleton"
import { WidgetFrame } from "@/components/dashboard-builder/widgets/widget-shell"
import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"

interface HistogramWidgetProps {
	dataState: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
	onRemove: () => void
	onClone?: () => void
	onConfigure?: () => void
	onFix?: () => void
}

export const HistogramWidget = memo(function HistogramWidget({
	dataState,
	display,
	mode,
	onRemove,
	onClone,
	onConfigure,
	onFix,
}: HistogramWidgetProps) {
	const entry = getChartById(display.chartId ?? "query-builder-histogram")
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
			onFix={onFix}
			loadingSkeleton={<ChartSkeleton variant="histogram" />}
		>
			<Suspense fallback={<ChartSkeleton variant="histogram" />}>
				<ChartComponent
					data={chartData}
					className="h-full w-full aspect-auto"
					tooltip={tooltip}
					unit={display.unit}
					histogram={display.histogram}
					logScale={display.yAxis?.logScale}
				/>
			</Suspense>
		</WidgetFrame>
	)
})
