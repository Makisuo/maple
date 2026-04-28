import { Text, View } from "react-native"

interface SingleBarChartProps {
	data: Array<{ bucket: string; value: number }>
	height?: number
	color: string
}

export function SingleBarChart({ data, height = 100, color }: SingleBarChartProps) {
	const max = Math.max(...data.map((d) => d.value), 0.001)

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
					const barHeight = Math.max((bar.value / max) * height, 1)
					return (
						<View key={i} style={{ flex: 1, justifyContent: "flex-end", height }}>
							<View
								style={{
									width: "100%",
									height: barHeight,
									backgroundColor: color,
									borderRadius: 2,
								}}
							/>
						</View>
					)
				})}
			</View>
			<View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
				{labelIndices.map((idx) => (
					<Text key={idx} className="text-muted-foreground font-mono" style={{ fontSize: 10 }}>
						{formatLabel(data[idx].bucket)}
					</Text>
				))}
			</View>
		</View>
	)
}
