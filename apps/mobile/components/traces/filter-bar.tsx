import { ScrollView, Text, TouchableOpacity, View } from "react-native"
import type { TimeRangeKey } from "../../lib/time-utils"

export interface TracesFilterState {
	timeKey: TimeRangeKey
	serviceName: string
	spanName: string
	errorsOnly: boolean
}

export const DEFAULT_FILTER_STATE: TracesFilterState = {
	timeKey: "24h",
	serviceName: "",
	spanName: "",
	errorsOnly: false,
}

interface FilterBarProps {
	filterState: TracesFilterState
	onRemoveFilter: (key: keyof TracesFilterState) => void
	onOpenFilters: () => void
}

export function FilterBar({ filterState, onRemoveFilter, onOpenFilters }: FilterBarProps) {
	const activeCount = [
		filterState.serviceName,
		filterState.spanName,
		filterState.errorsOnly,
	].filter(Boolean).length

	return (
		<View className="px-5 pb-3">
			<ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
				{/* Filter button */}
				<TouchableOpacity
					onPress={onOpenFilters}
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
				{filterState.serviceName !== "" && (
					<FilterChip
						label={`Service: ${filterState.serviceName}`}
						onRemove={() => onRemoveFilter("serviceName")}
					/>
				)}
				{filterState.spanName !== "" && (
					<FilterChip
						label={`Span: ${filterState.spanName}`}
						onRemove={() => onRemoveFilter("spanName")}
					/>
				)}
				{filterState.errorsOnly && (
					<FilterChip
						label="Errors only"
						onRemove={() => onRemoveFilter("errorsOnly")}
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
			<TouchableOpacity onPress={onRemove} hitSlop={8}>
				<Text className="text-xs text-muted-foreground font-mono">✕</Text>
			</TouchableOpacity>
		</View>
	)
}
