import { useMemo, useState } from "react"
import { ActivityIndicator, RefreshControl, View } from "react-native"
import { hapticSuccess } from "../../../lib/haptics"
import { LegendList } from "@legendapp/list"
import { useInfiniteTraces } from "../../../hooks/use-infinite-traces"
import { useTracesFacets } from "../../../hooks/use-traces-facets"
import { TraceRow } from "../../../components/traces/trace-row"
import {
	FilterBar,
	DEFAULT_FILTER_STATE,
	type TracesFilterState,
} from "../../../components/traces/filter-bar"
import { FilterModal } from "../../../components/traces/filter-modal"
import { Screen, useScreenBottomPadding } from "../../../components/ui/screen"
import { ScreenHeader } from "../../../components/ui/screen-header"
import { EmptyView, ErrorView, LoadingView } from "../../../components/ui/state-view"
import type { TraceFilters } from "../../../lib/api"

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
	const bottomPadding = useScreenBottomPadding()

	const handleRemoveFilter = (key: keyof TracesFilterState) => {
		setFilterState((prev) => ({
			...prev,
			[key]: key === "errorsOnly" ? false : key === "timeKey" ? "24h" : "",
		}))
	}

	const subtitle = state.status === "success" ? `${state.data.length} traces` : "Loading traces..."

	return (
		<Screen>
			<ScreenHeader title="Traces" subtitle={subtitle} />

			<FilterBar
				filterState={filterState}
				onRemoveFilter={handleRemoveFilter}
				onOpenFilters={() => setModalVisible(true)}
			/>

			{state.status === "error" ? (
				<ErrorView message={state.error} onRetry={refresh} />
			) : state.status === "loading" ? (
				<LoadingView />
			) : (
				<LegendList
					data={state.data}
					keyExtractor={(item, index) => `${item.traceId}-${index}`}
					contentContainerStyle={{ paddingBottom: bottomPadding }}
					estimatedItemSize={85}
					recycleItems
					refreshControl={
						<RefreshControl
							refreshing={false}
							onRefresh={() => {
								hapticSuccess()
								refresh()
							}}
						/>
					}
					ItemSeparatorComponent={() => <View className="h-px bg-border mx-5" />}
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
					ListEmptyComponent={<EmptyView title="No traces found" />}
				/>
			)}

			<FilterModal
				visible={modalVisible}
				onClose={() => setModalVisible(false)}
				currentFilters={filterState}
				onApply={setFilterState}
				facets={facetsState.status === "success" ? facetsState.data : null}
			/>
		</Screen>
	)
}
