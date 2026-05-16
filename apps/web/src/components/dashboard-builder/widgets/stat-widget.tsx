import { memo } from "react"
import { ChartSkeleton } from "@maple/ui/components/charts/_shared/chart-skeleton"
import { StatSparkline } from "@maple/ui/components/charts/sparkline/stat-sparkline"
import { formatValueByUnit } from "@maple/ui/lib/format"
import { WidgetFrame } from "@/components/dashboard-builder/widgets/widget-shell"
import { useWidgetDataSource, type WidgetDataSourceLike } from "@/hooks/use-widget-data"
import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"

interface StatWidgetProps {
	dataState: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
	onRemove: () => void
	onClone?: () => void
	onConfigure?: () => void
	onFix?: () => void
}

export function formatValue(value: unknown, unit?: string, prefix?: string, suffix?: string): string {
	if (value === null || value === undefined) return "-"
	if (typeof value === "object") return "—"

	const num = typeof value === "number" ? value : Number(value)
	if (Number.isNaN(num)) return String(value)

	const formatted = formatValueByUnit(num, unit)
	return `${prefix ?? ""}${formatted}${suffix ?? ""}`
}

export function getThresholdColor(
	value: unknown,
	thresholds?: ReadonlyArray<{ value: number; color: string }>,
): string | undefined {
	if (!thresholds || thresholds.length === 0) return undefined
	if (value === null || value === undefined || typeof value === "object") return undefined
	const num = typeof value === "number" ? value : Number(value)
	if (Number.isNaN(num)) return undefined

	const sorted = thresholds.toSorted((a, b) => b.value - a.value)
	for (const t of sorted) {
		if (num >= t.value) return t.color
	}
	return undefined
}

/**
 * Fetches the stat sparkline's data source and renders the trend. Kept as a
 * separate component so the `useWidgetDataSource` hook (which reads the
 * dashboard time-range context) only runs when a sparkline is configured —
 * a plain stat widget then has no dependency on a dashboard provider.
 */
function StatSparklineLoader({
	dataSource,
	color,
}: {
	dataSource: WidgetDataSourceLike
	color: string
}) {
	const { dataState } = useWidgetDataSource(dataSource)
	const data =
		dataState.status === "ready" && Array.isArray(dataState.data) ? dataState.data : []
	return <StatSparkline data={data} color={color} className="h-10 w-full shrink-0" />
}

export const StatWidget = memo(function StatWidget({
	dataState,
	display,
	mode,
	onRemove,
	onClone,
	onConfigure,
	onFix,
}: StatWidgetProps) {
	const displayName = display.title || "Untitled"
	const value = dataState.status === "ready" ? dataState.data : undefined
	const formattedValue = formatValue(value, display.unit, display.prefix, display.suffix)
	const thresholdColor = getThresholdColor(value, display.thresholds)

	const sparklineSource =
		display.sparkline?.enabled === true ? display.sparkline.dataSource : undefined

	const valueText = (
		<span className="text-2xl font-bold" style={thresholdColor ? { color: thresholdColor } : undefined}>
			{formattedValue}
		</span>
	)

	return (
		<WidgetFrame
			title={displayName}
			dataState={dataState}
			mode={mode}
			onRemove={onRemove}
			onClone={onClone}
			onConfigure={onConfigure}
			onFix={onFix}
			contentClassName={
				sparklineSource
					? "flex-1 min-h-0 flex flex-col"
					: "flex-1 min-h-0 flex items-center justify-center p-4"
			}
			loadingSkeleton={
				sparklineSource ? (
					<div className="flex h-full w-full flex-col">
						<div className="flex flex-1 items-center justify-center">
							<ChartSkeleton variant="stat" />
						</div>
						<ChartSkeleton variant="line" className="h-10 shrink-0" />
					</div>
				) : (
					<ChartSkeleton variant="stat" />
				)
			}
		>
			{sparklineSource ? (
				<>
					<div className="flex flex-1 items-center justify-center px-4 pt-4">{valueText}</div>
					<StatSparklineLoader
						dataSource={sparklineSource}
						color={thresholdColor ?? "var(--chart-1)"}
					/>
				</>
			) : (
				valueText
			)}
		</WidgetFrame>
	)
})
