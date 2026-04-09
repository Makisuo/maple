import { Text, View } from "react-native"

const COLORS = {
	p99: "#8b5cf6",
	p95: "#d4873b",
	p50: "#5cb88a",
}

interface PercentileBarChartProps {
	data: Array<{ bucket: string; p50: number; p95: number; p99: number }>
	height?: number
}

export function PercentileBarChart({
	data,
	height = 100,
}: PercentileBarChartProps) {
	const max = Math.max(...data.map((d) => d.p99), 0.001)

	const labelIndices: number[] = []
	if (data.length > 0) {
		const step = Math.max(Math.floor(data.length / 4), 1)
		for (let i = 0; i < data.length; i += step) {
			labelIndices.push(i)
		}
		const lastIdx = data.length - 1
		if (!labelIndices.includes(lastIdx)) {
			labelIndices.push(lastIdx)
		}
	}

	const formatLabel = (bucket: string) => {
		try {
			const date = new Date(bucket.includes("T") ? bucket : bucket.replace(" ", "T") + "Z")
			return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
		} catch {
			return bucket.slice(11, 16)
		}
	}

	return (
		<View>
			<View style={{ flexDirection: "row", alignItems: "flex-end", height, gap: 2 }}>
				{data.map((bar, i) => {
					const p99Height = Math.max((bar.p99 / max) * height, 1)
					const p95Height = Math.max((bar.p95 / max) * height, 1)
					const p50Height = Math.max((bar.p50 / max) * height, 1)

					return (
						<View
							key={i}
							style={{ flex: 1, justifyContent: "flex-end", height, position: "relative" }}
						>
							{/* P99 — back layer */}
							<View
								style={{
									position: "absolute",
									bottom: 0,
									left: 0,
									right: 0,
									height: p99Height,
									backgroundColor: COLORS.p99,
									borderRadius: 2,
									opacity: 0.4,
								}}
							/>
							{/* P95 — middle layer */}
							<View
								style={{
									position: "absolute",
									bottom: 0,
									left: 0,
									right: 0,
									height: p95Height,
									backgroundColor: COLORS.p95,
									borderRadius: 2,
									opacity: 0.6,
								}}
							/>
							{/* P50 — front layer */}
							<View
								style={{
									position: "absolute",
									bottom: 0,
									left: 0,
									right: 0,
									height: p50Height,
									backgroundColor: COLORS.p50,
									borderRadius: 2,
								}}
							/>
						</View>
					)
				})}
			</View>

			{/* X-axis labels */}
			<View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
				{labelIndices.map((idx) => (
					<Text
						key={idx}
						className="text-muted-foreground font-mono"
						style={{ fontSize: 10 }}
					>
						{formatLabel(data[idx].bucket)}
					</Text>
				))}
			</View>

			{/* Legend */}
			<View style={{ flexDirection: "row", gap: 12, marginTop: 8 }}>
				{(["p50", "p95", "p99"] as const).map((key) => (
					<View key={key} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
						<View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS[key] }} />
						<Text className="text-muted-foreground font-mono" style={{ fontSize: 10 }}>
							{key.toUpperCase()}
						</Text>
					</View>
				))}
			</View>
		</View>
	)
}
