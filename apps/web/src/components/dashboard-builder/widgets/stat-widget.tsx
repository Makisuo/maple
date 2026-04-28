import { memo } from "react"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatValueByUnit } from "@maple/ui/lib/format"
import { WidgetFrame } from "@/components/dashboard-builder/widgets/widget-shell"
import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"

interface StatWidgetProps {
	dataState: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
	onRemove: () => void
	onClone?: () => void
	onConfigure?: () => void
}

export function formatValue(value: unknown, unit?: string, prefix?: string, suffix?: string): string {
	if (value === null || value === undefined) return "-"
	if (typeof value === "object") return "—"

	const num = typeof value === "number" ? value : Number(value)
	if (Number.isNaN(num)) return String(value)

	const formatted = formatValueByUnit(num, unit)
	return `${prefix ?? ""}${formatted}${suffix ?? ""}`
}

function getThresholdColor(
	value: unknown,
	thresholds?: Array<{ value: number; color: string }>,
): string | undefined {
	if (!thresholds || thresholds.length === 0) return undefined
	if (value === null || value === undefined || typeof value === "object") return undefined
	const num = typeof value === "number" ? value : Number(value)
	if (Number.isNaN(num)) return undefined

	const sorted = [...thresholds].sort((a, b) => b.value - a.value)
	for (const t of sorted) {
		if (num >= t.value) return t.color
	}
	return undefined
}

export const StatWidget = memo(function StatWidget({
	dataState,
	display,
	mode,
	onRemove,
	onClone,
	onConfigure,
}: StatWidgetProps) {
	const displayName = display.title || "Untitled"
	const value = dataState.status === "ready" ? dataState.data : undefined
	const formattedValue = formatValue(value, display.unit, display.prefix, display.suffix)
	const thresholdColor = getThresholdColor(value, display.thresholds)

	return (
		<WidgetFrame
			title={displayName}
			dataState={dataState}
			mode={mode}
			onRemove={onRemove}
			onClone={onClone}
			onConfigure={onConfigure}
			contentClassName="flex-1 min-h-0 flex items-center justify-center p-4"
			loadingSkeleton={<Skeleton className="h-8 w-24" />}
		>
			<span
				className="text-2xl font-bold"
				style={thresholdColor ? { color: thresholdColor } : undefined}
			>
				{formattedValue}
			</span>
		</WidgetFrame>
	)
})
