import { useState } from "react"
import { ActivityIndicator, RefreshControl, Text, View } from "react-native"
import { LegendList } from "@legendapp/list"
import { Host, Picker, Text as ExpoText } from "@expo/ui/swift-ui"
import { pickerStyle, tag } from "@expo/ui/swift-ui/modifiers"
import { useInfiniteLogs } from "../../hooks/use-infinite-logs"
import { formatLogTimestamp } from "../../lib/format"
import type { Log } from "../../lib/api"
import type { TimeRangeKey } from "../../lib/time-utils"

const SEVERITY_COLORS: Record<string, string> = {
	TRACE: "#8a8078",
	DEBUG: "#6b9ff0",
	INFO: "#5cb88a",
	WARN: "#c89b48",
	ERROR: "#c45a3c",
	FATAL: "#a03a20",
}

const TIME_OPTIONS: TimeRangeKey[] = ["1h", "24h", "7d", "30d"]

function LogRow({ item }: { item: Log }) {
	const severity = item.severityText.toUpperCase()
	const color = SEVERITY_COLORS[severity] ?? "#8a8078"

	return (
		<View className="flex-row px-5 py-2.5 border-b border-border">
			<View
				className="w-1 rounded-full mr-3 self-stretch"
				style={{ backgroundColor: color }}
			/>
			<View className="flex-1">
				<View className="flex-row items-center mb-1">
					<Text
						className="text-[10px] font-bold font-mono mr-2"
						style={{ color }}
					>
						{severity}
					</Text>
					<Text className="text-[10px] text-muted-foreground font-mono">
						{formatLogTimestamp(item.timestamp)}
					</Text>
				</View>
				<Text
					className="text-xs text-foreground font-mono leading-4"
					numberOfLines={2}
				>
					{item.body}
				</Text>
				<Text className="text-[10px] text-muted-foreground font-mono mt-1">
					{item.serviceName}
				</Text>
			</View>
		</View>
	)
}

export default function LogsScreen() {
	const [selectedIndex, setSelectedIndex] = useState(1)
	const timeKey = TIME_OPTIONS[selectedIndex]
	const { state, fetchNextPage, refresh } = useInfiniteLogs(timeKey)

	return (
		<View className="flex-1 bg-background">
			{/* Header */}
			<View className="px-5 pt-16 pb-3">
				<Text className="text-2xl font-bold text-foreground font-mono">
					Logs
				</Text>
				<Text className="text-xs text-muted-foreground font-mono mt-0.5">
					{state.status === "success"
						? `${state.data.length} logs in last ${timeKey}`
						: "Loading logs..."}
				</Text>
			</View>

			{/* Time Range Segment Control */}
			<View className="px-5 pb-5">
				<Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
					<Picker
						selection={selectedIndex}
						onSelectionChange={(value) => setSelectedIndex(value as number)}
						modifiers={[pickerStyle("segmented")]}
					>
						{TIME_OPTIONS.map((option, i) => (
							<ExpoText key={option} modifiers={[tag(i)]}>
								{option}
							</ExpoText>
						))}
					</Picker>
				</Host>
			</View>

			{/* Content */}
			{state.status === "error" ? (
				<View className="flex-1 items-center justify-center px-5">
					<Text className="text-sm text-destructive font-mono text-center">
						{state.error}
					</Text>
					<Text
						className="text-sm text-primary font-mono mt-3"
						onPress={refresh}
					>
						Tap to retry
					</Text>
				</View>
			) : state.status === "loading" ? (
				<View className="flex-1 items-center justify-center">
					<ActivityIndicator size="small" />
				</View>
			) : (
				<LegendList
					data={state.data}
					keyExtractor={(item, index) => `${item.timestamp}-${item.spanId}-${index}`}
					contentContainerStyle={{ paddingBottom: 100 }}
					estimatedItemSize={65}
					recycleItems
					refreshControl={
						<RefreshControl refreshing={false} onRefresh={refresh} />
					}
					renderItem={({ item }) => <LogRow item={item} />}
					onEndReached={fetchNextPage}
					onEndReachedThreshold={0.5}
					ListFooterComponent={
						state.isFetchingNextPage ? (
							<View className="py-4 items-center">
								<ActivityIndicator size="small" />
							</View>
						) : null
					}
					ListEmptyComponent={
						<View className="flex-1 items-center justify-center py-20">
							<Text className="text-sm text-muted-foreground font-mono">
								No logs found
							</Text>
						</View>
					}
				/>
			)}
		</View>
	)
}
