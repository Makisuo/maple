import { View } from "react-native"

interface SkeletonBlockProps {
	height?: number
}

export function SkeletonBlock({ height = 20 }: SkeletonBlockProps) {
	return <View className="bg-muted rounded-md" style={{ height, opacity: 0.4 }} />
}

interface TelemetrySkeletonProps {
	rows?: number
}

/** Four-row telemetry card skeleton used on the Overview screen. */
export function TelemetrySkeleton({ rows = 4 }: TelemetrySkeletonProps) {
	return (
		<View className="bg-card rounded-xl overflow-hidden">
			{Array.from({ length: rows }).map((_, i) => (
				<View key={i} className={`px-4 py-3.5 ${i < rows - 1 ? "border-b border-border" : ""}`}>
					<SkeletonBlock height={12} />
					<View style={{ height: 6 }} />
					<SkeletonBlock height={24} />
				</View>
			))}
		</View>
	)
}

/** Single chart card skeleton: label row + chart body. */
export function ChartSkeleton() {
	return (
		<View className="bg-card rounded-xl border border-border p-4">
			<View className="flex-row justify-between mb-3">
				<SkeletonBlock height={12} />
			</View>
			<SkeletonBlock height={100} />
		</View>
	)
}
