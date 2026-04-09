import { useMemo, useState } from "react"
import { ActivityIndicator, RefreshControl, Text, View } from "react-native"
import { LegendList } from "@legendapp/list"
import { useInfiniteTraces } from "../../hooks/use-infinite-traces"
import { useTracesFacets } from "../../hooks/use-traces-facets"
import { TraceRow } from "../../components/traces/trace-row"
import { FilterBar, DEFAULT_FILTER_STATE, type TracesFilterState } from "../../components/traces/filter-bar"
import { FilterModal } from "../../components/traces/filter-modal"
import type { TraceFilters } from "../../lib/api"

const TIME_LABELS: Record<string, string> = {
	"1h": "1h",
	"24h": "24h",
	"7d": "7d",
	"30d": "30d",
}

export default function TracesScreen() {
	const [filterState, setFilterState] = useState<TracesFilterState>(DEFAULT_FILTER_STATE)
	const [modalVisible, setModalVisible] = useState(false)

	const apiFilters = useMemo<TraceFilters | undefined>(() => {
		const f: TraceFilters = {}
		if (filterState.serviceName) f.serviceName = filterState.serviceName
		if (filterState.spanName) f.spanName = filterState.spanName
		if (filterState.errorsOnly) f.errorsOnly = true
		return Object.keys(f).length > 0 ? f : undefined
	}, [filterState.serviceName, filterState.spanName, filterState.errorsOnly])

	const { state, fetchNextPage, refresh } = useInfiniteTraces(filterState.timeKey, apiFilters)
	const { state: facetsState } = useTracesFacets(filterState.timeKey)

	const handleRemoveFilter = (key: keyof TracesFilterState) => {
		setFilterState((prev) => ({
			...prev,
			[key]: key === "errorsOnly" ? false : key === "timeKey" ? "24h" : "",
		}))
	}

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
								? `${state.data.length} traces in last ${TIME_LABELS[filterState.timeKey]}`
								: "Loading traces..."}
						</Text>
					</View>
				</View>
			</View>

			{/* Filter Bar */}
			<FilterBar
				filterState={filterState}
				onRemoveFilter={handleRemoveFilter}
				onOpenFilters={() => setModalVisible(true)}
			/>

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
					keyExtractor={(item, index) => `${item.traceId}-${index}`}
					contentContainerStyle={{ paddingBottom: 100 }}
					estimatedItemSize={85}
					recycleItems
					refreshControl={
						<RefreshControl refreshing={false} onRefresh={refresh} />
					}
					ItemSeparatorComponent={() => (
						<View className="h-px bg-border mx-5" />
					)}
					renderItem={({ item }) => <TraceRow trace={item} />}
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
								No traces found
							</Text>
						</View>
					}
				/>
			)}

			{/* Filter Modal */}
			<FilterModal
				visible={modalVisible}
				onClose={() => setModalVisible(false)}
				currentFilters={filterState}
				onApply={setFilterState}
				facets={facetsState.status === "success" ? facetsState.data : null}
			/>
		</View>
	)
}
