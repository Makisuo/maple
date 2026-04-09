import { ActivityIndicator, ScrollView, Text, View } from "react-native"
import { useLocalSearchParams } from "expo-router"
import { useDashboards } from "../../../hooks/use-dashboards"
import { DashboardWidgetView } from "../../../components/dashboards/dashboard-widget-view"
import type {
	DashboardDocument,
	DashboardWidget,
	WidgetTimeRange,
} from "../../../lib/api"

function timeRangeLabel(timeRange: WidgetTimeRange): string {
	if (timeRange.type === "relative") return `Last ${timeRange.value}`
	return "Custom range"
}

function sortWidgets(widgets: readonly DashboardWidget[]): DashboardWidget[] {
	return [...widgets].sort((a, b) => {
		if (a.layout.y !== b.layout.y) return a.layout.y - b.layout.y
		return a.layout.x - b.layout.x
	})
}

export default function DashboardDetailScreen() {
	const { id } = useLocalSearchParams<{ id: string }>()
	const { state, refresh } = useDashboards()

	if (state.status === "loading") {
		return (
			<View className="flex-1 bg-background items-center justify-center">
				<ActivityIndicator size="small" />
			</View>
		)
	}

	if (state.status === "error") {
		return (
			<View className="flex-1 bg-background items-center justify-center px-5">
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
		)
	}

	const dashboard = state.data.find((d) => d.id === id)
	if (!dashboard) {
		return (
			<View className="flex-1 bg-background items-center justify-center px-5">
				<Text className="text-sm text-muted-foreground font-mono text-center">
					Dashboard not found.
				</Text>
			</View>
		)
	}

	return <DashboardDetailContent dashboard={dashboard} />
}

function DashboardDetailContent({ dashboard }: { dashboard: DashboardDocument }) {
	const widgets = sortWidgets(dashboard.widgets)

	return (
		<View className="flex-1 bg-background">
			{/* Header */}
			<View className="px-5 pt-16 pb-3">
				<Text
					className="text-2xl font-bold text-foreground font-mono"
					numberOfLines={2}
				>
					{dashboard.name}
				</Text>
				{dashboard.description ? (
					<Text
						className="text-xs text-muted-foreground font-mono mt-1"
						numberOfLines={2}
					>
						{dashboard.description}
					</Text>
				) : null}
				<View className="flex-row items-center mt-2 gap-2">
					<View className="rounded-lg border border-border px-2.5 py-1">
						<Text className="text-[10px] text-foreground font-mono">
							{timeRangeLabel(dashboard.timeRange)}
						</Text>
					</View>
					<Text className="text-[10px] text-muted-foreground font-mono">
						{widgets.length} widget{widgets.length === 1 ? "" : "s"}
					</Text>
				</View>
			</View>

			{widgets.length === 0 ? (
				<View className="flex-1 items-center justify-center px-5">
					<Text className="text-sm text-muted-foreground font-mono text-center">
						This dashboard has no widgets.
					</Text>
				</View>
			) : (
				<ScrollView
					className="flex-1"
					contentContainerStyle={{ paddingTop: 4, paddingBottom: 100 }}
				>
					{widgets.map((widget) => (
						<DashboardWidgetView
							key={widget.id}
							widget={widget}
							timeRange={dashboard.timeRange}
						/>
					))}
				</ScrollView>
			)}
		</View>
	)
}
