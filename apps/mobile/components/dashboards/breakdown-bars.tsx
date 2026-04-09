import { Text, View } from "react-native"
import type { CustomBreakdownItem } from "../../lib/api"
import { getServiceColor } from "../../lib/colors"

interface BreakdownBarsProps {
	items: CustomBreakdownItem[]
	limit?: number
	colorOverrides?: Record<string, string>
}

const DEFAULT_LIMIT = 10

function formatValue(n: number): string {
	if (!Number.isFinite(n)) return "0"
	if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
	if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
	if (Number.isInteger(n)) return n.toString()
	return n.toFixed(2)
}

export function BreakdownBars({
	items,
	limit = DEFAULT_LIMIT,
	colorOverrides,
}: BreakdownBarsProps) {
	if (items.length === 0) {
		return (
			<View className="items-center justify-center" style={{ height: 80 }}>
				<Text className="text-xs text-muted-foreground font-mono">No data</Text>
			</View>
		)
	}

	const sorted = [...items].sort((a, b) => b.value - a.value)
	const visible = sorted.slice(0, limit)
	const remaining = sorted.length - visible.length
	const max = Math.max(...visible.map((i) => i.value), 1)

	const colorFor = (key: string) =>
		colorOverrides?.[key] ?? getServiceColor(key)

	return (
		<View style={{ gap: 10 }}>
			{visible.map((item) => {
				const widthPct = Math.max((item.value / max) * 100, 1)
				return (
					<View key={item.name}>
						<View
							style={{
								flexDirection: "row",
								justifyContent: "space-between",
								marginBottom: 4,
							}}
						>
							<Text
								className="text-xs text-foreground font-mono"
								numberOfLines={1}
								style={{ flex: 1, marginRight: 8 }}
							>
								{item.name || "—"}
							</Text>
							<Text className="text-xs text-muted-foreground font-mono">
								{formatValue(item.value)}
							</Text>
						</View>
						<View
							style={{
								height: 4,
								borderRadius: 2,
								backgroundColor: "rgba(255,255,255,0.05)",
								overflow: "hidden",
							}}
						>
							<View
								style={{
									height: "100%",
									width: `${widthPct}%`,
									backgroundColor: colorFor(item.name),
								}}
							/>
						</View>
					</View>
				)
			})}
			{remaining > 0 ? (
				<Text className="text-[10px] text-muted-foreground font-mono mt-1">
					+{remaining} more
				</Text>
			) : null}
		</View>
	)
}
