import { Text, View } from "react-native"
import type { CustomTimeseriesPoint } from "../../lib/api"
import { getServiceColor } from "../../lib/colors"

interface TimeseriesChartProps {
	points: CustomTimeseriesPoint[]
	height?: number
	colorOverrides?: Record<string, string>
}

const DEFAULT_HEIGHT = 120

function formatLabel(bucket: string) {
	try {
		const d = new Date(bucket.includes("T") ? bucket : bucket.replace(" ", "T") + "Z")
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
	} catch {
		return bucket.slice(11, 16)
	}
}

export function TimeseriesChart({ points, height = DEFAULT_HEIGHT, colorOverrides }: TimeseriesChartProps) {
	if (points.length === 0) {
		return (
			<View className="items-center justify-center" style={{ height }}>
				<Text className="text-xs text-muted-foreground font-mono">No data</Text>
			</View>
		)
	}

	// Discover the union of series keys, in order of first appearance.
	const seriesKeys: string[] = []
	const seen = new Set<string>()
	for (const p of points) {
		for (const key of Object.keys(p.series)) {
			if (!seen.has(key)) {
				seen.add(key)
				seriesKeys.push(key)
			}
		}
	}

	const colorFor = (key: string) => colorOverrides?.[key] ?? getServiceColor(key)

	// Find the max stacked total across buckets so all bars share a scale.
	let max = 0
	for (const p of points) {
		let sum = 0
		for (const key of seriesKeys) {
			const v = p.series[key]
			if (typeof v === "number" && Number.isFinite(v)) sum += v
		}
		if (sum > max) max = sum
	}
	if (max <= 0) max = 1

	// Pick ~5 evenly spaced x-axis labels.
	const labelIndices: number[] = []
	const step = Math.max(Math.floor(points.length / 4), 1)
	for (let i = 0; i < points.length; i += step) labelIndices.push(i)
	const lastIdx = points.length - 1
	if (!labelIndices.includes(lastIdx)) labelIndices.push(lastIdx)

	return (
		<View>
			<View
				style={{
					flexDirection: "row",
					alignItems: "flex-end",
					height,
					gap: 2,
				}}
			>
				{points.map((point, i) => {
					let total = 0
					for (const key of seriesKeys) {
						const v = point.series[key]
						if (typeof v === "number" && Number.isFinite(v)) total += v
					}
					const barHeight = Math.max((total / max) * height, total > 0 ? 1 : 0)

					return (
						<View key={i} style={{ flex: 1, justifyContent: "flex-end", height }}>
							<View style={{ width: "100%", borderRadius: 2, overflow: "hidden" }}>
								{seriesKeys.map((key) => {
									const v = point.series[key]
									if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
										return null
									}
									const segHeight = (v / max) * height
									return (
										<View
											key={key}
											style={{
												height: segHeight,
												backgroundColor: colorFor(key),
											}}
										/>
									)
								})}
								{barHeight === 0 ? (
									<View style={{ height: 1, backgroundColor: "transparent" }} />
								) : null}
							</View>
						</View>
					)
				})}
			</View>

			<View
				style={{
					flexDirection: "row",
					justifyContent: "space-between",
					marginTop: 6,
				}}
			>
				{labelIndices.map((idx) => (
					<Text key={idx} className="text-muted-foreground font-mono" style={{ fontSize: 10 }}>
						{formatLabel(points[idx].bucket)}
					</Text>
				))}
			</View>

			{seriesKeys.length > 1 ? (
				<View
					style={{
						flexDirection: "row",
						flexWrap: "wrap",
						gap: 8,
						marginTop: 10,
					}}
				>
					{seriesKeys.map((key) => (
						<View key={key} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
							<View
								style={{
									width: 8,
									height: 8,
									borderRadius: 2,
									backgroundColor: colorFor(key),
								}}
							/>
							<Text
								className="text-muted-foreground font-mono"
								style={{ fontSize: 10 }}
								numberOfLines={1}
							>
								{key}
							</Text>
						</View>
					))}
				</View>
			) : null}
		</View>
	)
}
