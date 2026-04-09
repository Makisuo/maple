import { Text, View } from "react-native"
import type { WidgetDisplayConfig } from "../../lib/api"
import { formatDuration } from "../../lib/format"

interface StatTileProps {
	value: number
	display: WidgetDisplayConfig
	compact?: boolean
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

export function StatTile({ value, display, compact = false }: StatTileProps) {
	const formatted = formatNumber(value, display.unit)
	const color = thresholdColor(value, display)

	const valueSize = compact ? 22 : 28
	const prefixSize = compact ? 13 : 16
	const suffixSize = compact ? 11 : 13

	const prefixStyle = color
		? { fontSize: prefixSize, marginRight: 4, color }
		: { fontSize: prefixSize, marginRight: 4 }
	const valueStyle = color
		? { fontSize: valueSize, color }
		: { fontSize: valueSize }

	return (
		<View
			style={{
				flexDirection: "row",
				alignItems: "baseline",
				justifyContent: "flex-start",
			}}
		>
			{display.prefix ? (
				<Text
					className="text-foreground font-mono"
					style={prefixStyle}
				>
					{display.prefix}
				</Text>
			) : null}
			<Text
				className="text-foreground font-mono font-bold"
				style={valueStyle}
				numberOfLines={1}
				adjustsFontSizeToFit
			>
				{formatted}
			</Text>
			{display.suffix ? (
				<Text
					className="text-muted-foreground font-mono"
					style={{ fontSize: suffixSize, marginLeft: 6 }}
					numberOfLines={1}
				>
					{display.suffix}
				</Text>
			) : null}
		</View>
	)
}
