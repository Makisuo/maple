import { Text, View } from "react-native"

interface BarData {
	bucket: string
	primary: number
	error: number
}

interface StackedBarChartProps {
	data: BarData[]
	height?: number
	primaryColor?: string
	errorColor?: string
}

export function StackedBarChart({
	data,
	height = 100,
	primaryColor = "#d4873b",
	errorColor = "#c45a3c",
}: StackedBarChartProps) {
	const maxTotal = Math.max(...data.map((d) => d.primary + d.error), 1)

	// Pick ~5 evenly spaced labels for the x-axis
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
					const total = bar.primary + bar.error
					const barHeight = Math.max((total / maxTotal) * height, 1)
					const errorHeight = total > 0 ? (bar.error / total) * barHeight : 0
					const primaryHeight = barHeight - errorHeight

					return (
						<View
							key={i}
							style={{
								flex: 1,
								justifyContent: "flex-end",
								height,
							}}
						>
							<View style={{ width: "100%", borderRadius: 2, overflow: "hidden" }}>
								<View
									style={{
										height: primaryHeight,
										backgroundColor: primaryColor,
									}}
								/>
								{errorHeight > 0 && (
									<View
										style={{
											height: errorHeight,
											backgroundColor: errorColor,
										}}
									/>
								)}
							</View>
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
