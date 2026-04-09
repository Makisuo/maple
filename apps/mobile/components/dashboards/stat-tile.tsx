import { Text, View } from "react-native"
import type { WidgetDisplayConfig } from "../../lib/api"
import { formatDuration } from "../../lib/format"

interface StatTileProps {
	value: number
	display: WidgetDisplayConfig
}

function formatNumber(n: number, unit?: string): string {
	if (!Number.isFinite(n)) return "—"
	if (unit === "ms") return formatDuration(n)
	if (unit === "s") return formatDuration(n * 1000)
	if (unit === "%") return `${n.toFixed(n < 10 ? 2 : 1)}%`

	const abs = Math.abs(n)
	if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
	if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
	if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}k`
	if (Number.isInteger(n)) return n.toString()
	return n.toFixed(2)
}

function thresholdColor(value: number, display: WidgetDisplayConfig): string | undefined {
	const thresholds = display.thresholds
	if (!thresholds || thresholds.length === 0) return undefined
	let chosen: string | undefined
	for (const t of thresholds) {
		if (value >= t.value) chosen = t.color
	}
	return chosen
}

export function StatTile({ value, display }: StatTileProps) {
	const formatted = formatNumber(value, display.unit)
	const color = thresholdColor(value, display)

	return (
		<View
			style={{
				flexDirection: "row",
				alignItems: "baseline",
				justifyContent: "flex-start",
				paddingVertical: 4,
			}}
		>
			{display.prefix ? (
				<Text
					className="text-foreground font-mono"
					style={{ fontSize: 18, marginRight: 4, color }}
				>
					{display.prefix}
				</Text>
			) : null}
			<Text
				className="text-foreground font-mono font-bold"
				style={{ fontSize: 32, color }}
			>
				{formatted}
			</Text>
			{display.suffix ? (
				<Text
					className="text-muted-foreground font-mono"
					style={{ fontSize: 14, marginLeft: 6 }}
				>
					{display.suffix}
				</Text>
			) : null}
		</View>
	)
}
