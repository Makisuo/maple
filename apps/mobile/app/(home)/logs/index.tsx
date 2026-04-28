import { useMemo, useState } from "react"
import { ActivityIndicator, RefreshControl, View } from "react-native"
import { hapticSuccess } from "../../../lib/haptics"
import { LegendList } from "@legendapp/list"
import { useInfiniteLogs } from "../../../hooks/use-infinite-logs"
import { useLogsFacets } from "../../../hooks/use-logs-facets"
import { LogRow } from "../../../components/logs/log-row"
import {
	FilterBar,
	DEFAULT_LOGS_FILTER_STATE,
	type LogsFilterState,
} from "../../../components/logs/filter-bar"
import { FilterModal } from "../../../components/logs/filter-modal"
import { Screen, useScreenBottomPadding } from "../../../components/ui/screen"
import { ScreenHeader } from "../../../components/ui/screen-header"
import { EmptyView, ErrorView, LoadingView } from "../../../components/ui/state-view"
import type { LogsFilters } from "../../../lib/api"

export default function LogsScreen() {
	const [filterState, setFilterState] = useState<LogsFilterState>(DEFAULT_LOGS_FILTER_STATE)
	const [modalVisible, setModalVisible] = useState(false)

	const apiFilters = useMemo<LogsFilters | undefined>(() => {
		const f: LogsFilters = {}
		if (filterState.service) f.service = filterState.service
		if (filterState.severity) f.severity = filterState.severity
		if (filterState.search) f.search = filterState.search
		return Object.keys(f).length > 0 ? f : undefined
	}, [filterState.service, filterState.severity, filterState.search])

	const { state, fetchNextPage, refresh } = useInfiniteLogs(filterState.timeKey, apiFilters)
	const { state: facetsState } = useLogsFacets(filterState.timeKey)
	const bottomPadding = useScreenBottomPadding()

	const handleRemoveFilter = (key: keyof LogsFilterState) => {
		setFilterState((prev) => ({
			...prev,
			[key]: key === "timeKey" ? "24h" : "",
		}))
	}

	const subtitle = state.status === "success" ? `${state.data.length} logs` : "Loading logs..."

	return (
		<Screen>
			<ScreenHeader title="Logs" subtitle={subtitle} />

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
					keyExtractor={(item, index) => `${item.timestamp}-${item.spanId}-${index}`}
					contentContainerStyle={{ paddingBottom: bottomPadding }}
					estimatedItemSize={65}
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
