import { ActivityIndicator, FlatList, RefreshControl, Text, TextInput, View } from "react-native"
import { useTraces } from "../../hooks/use-traces"
import { TraceRow } from "../../components/traces/trace-row"

export default function TracesScreen() {
	const { state, refresh } = useTraces("24h")
	const isRefreshing = state.status === "loading"

	return (
		<View className="flex-1 bg-background">
			{/* Header */}
			<View className="px-5 pt-16 pb-3">
				<View className="flex-row justify-between items-start">
					<View>
						<Text className="text-2xl font-bold text-foreground font-mono">
							Traces
						</Text>
						<Text className="text-xs text-muted-foreground font-mono mt-0.5">
							{state.status === "success"
								? `${state.data.length} traces in last 24h`
								: "Loading traces..."}
						</Text>
					</View>
					<View className="flex-row items-center gap-2">
						<View className="rounded-lg border border-border px-3 py-1.5">
							<Text className="text-xs text-foreground font-mono">Last 24h</Text>
						</View>
					</View>
				</View>
			</View>

			{/* Search Bar */}
			<View className="px-5 pb-3">
				<View className="flex-row items-center bg-card rounded-lg px-3 py-2.5 border border-border">
					<Text className="text-muted-foreground mr-2">🔍</Text>
					<TextInput
						className="flex-1 text-sm text-foreground font-mono"
						placeholder="Search traces..."
						placeholderTextColor="#8a8078"
						editable={false}
					/>
				</View>
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
				<FlatList
					data={state.data}
					keyExtractor={(item) => item.traceId}
					contentContainerStyle={{ paddingBottom: 100 }}
					refreshControl={
						<RefreshControl refreshing={isRefreshing} onRefresh={refresh} />
					}
					ItemSeparatorComponent={() => (
						<View className="h-px bg-border mx-5" />
					)}
					renderItem={({ item }) => <TraceRow trace={item} />}
					ListEmptyComponent={
						<View className="flex-1 items-center justify-center py-20">
							<Text className="text-sm text-muted-foreground font-mono">
								No traces found
							</Text>
						</View>
					}
				/>
			)}
		</View>
	)
}
