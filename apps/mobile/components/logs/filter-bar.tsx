import { ScrollView, Text, TouchableOpacity, View } from "react-native"
import { hapticLight } from "../../lib/haptics"
import type { TimeRangeKey } from "../../lib/time-utils"

export interface LogsFilterState {
	timeKey: TimeRangeKey
	service: string
	severity: string
	search: string
}

export const DEFAULT_LOGS_FILTER_STATE: LogsFilterState = {
	timeKey: "24h",
	service: "",
	severity: "",
	search: "",
}

interface FilterBarProps {
	filterState: LogsFilterState
	onRemoveFilter: (key: keyof LogsFilterState) => void
	onOpenFilters: () => void
}

export function FilterBar({ filterState, onRemoveFilter, onOpenFilters }: FilterBarProps) {
	const activeCount = [filterState.service, filterState.severity, filterState.search].filter(Boolean).length

	return (
		<View className="px-5 pb-3">
			<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
				{/* Filter button */}
				<TouchableOpacity
					onPress={() => {
						hapticLight()
						onOpenFilters()
					}}
					className="flex-row items-center rounded-lg border border-border bg-card px-3 py-1.5"
				>
					<Text className="text-xs text-foreground font-mono">Filters</Text>
					{activeCount > 0 && (
						<View className="ml-1.5 rounded-full bg-primary px-1.5 min-w-[18px] items-center">
							<Text className="text-[10px] text-primary-foreground font-mono font-bold">
								{activeCount}
							</Text>
						</View>
					)}
				</TouchableOpacity>

				{/* Active filter chips */}
				{filterState.service !== "" && (
					<FilterChip
						label={`Service: ${filterState.service}`}
						onRemove={() => onRemoveFilter("service")}
					/>
				)}
				{filterState.severity !== "" && (
					<FilterChip
						label={`Severity: ${filterState.severity}`}
						onRemove={() => onRemoveFilter("severity")}
					/>
				)}
				{filterState.search !== "" && (
					<FilterChip
						label={`Search: ${filterState.search}`}
						onRemove={() => onRemoveFilter("search")}
					/>
				)}
			</ScrollView>
		</View>
	)
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
	return (
		<View className="flex-row items-center rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5">
			<Text className="text-xs text-foreground font-mono mr-1.5" numberOfLines={1}>
				{label}
			</Text>
			<TouchableOpacity
				onPress={() => {
					hapticLight()
					onRemove()
				}}
				hitSlop={8}
			>
				<Text className="text-xs text-muted-foreground font-mono">{"\u2715"}</Text>
			</TouchableOpacity>
		</View>
	)
}
