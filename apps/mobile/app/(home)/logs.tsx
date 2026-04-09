import { ActivityIndicator, RefreshControl, Text, View } from "react-native"
import { LegendList } from "@legendapp/list"
import { useInfiniteLogs } from "../../hooks/use-infinite-logs"
import { formatLogTimestamp } from "../../lib/format"
import { severityColors } from "../../lib/theme"
import { Screen, useScreenBottomPadding } from "../../components/ui/screen"
import { ScreenHeader } from "../../components/ui/screen-header"
import {
	EmptyView,
	ErrorView,
	LoadingView,
} from "../../components/ui/state-view"
import type { Log } from "../../lib/api"

function LogRow({ item }: { item: Log }) {
	const severity = item.severityText.toUpperCase()
	const color = severityColors[severity] ?? severityColors.TRACE

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
	const { state, fetchNextPage, refresh } = useInfiniteLogs("24h")
	const bottomPadding = useScreenBottomPadding()

	const subtitle =
		state.status === "success"
			? `${state.data.length} logs`
			: "Loading logs..."

	return (
		<Screen>
			<ScreenHeader title="Logs" subtitle={subtitle} />

			{state.status === "error" ? (
				<ErrorView message={state.error} onRetry={refresh} />
			) : state.status === "loading" ? (
				<LoadingView />
			) : (
				<LegendList
					data={state.data}
					keyExtractor={(item, index) => `${item.timestamp}-${item.spanId}-${index}`}
					contentContainerStyle={{ paddingBottom: bottomPadding }}
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
					ListEmptyComponent={<EmptyView title="No logs found" />}
				/>
			)}
		</Screen>
	)
}
