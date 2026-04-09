import { useMemo, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { Host, Picker, Text as ExpoText } from "@expo/ui/swift-ui"
import { pickerStyle, tag } from "@expo/ui/swift-ui/modifiers"
import { useDashboards } from "../../../hooks/use-dashboards"
import { DashboardWidgetView } from "../../../components/dashboards/dashboard-widget-view"
import type { TimeRangeKey } from "../../../lib/time-utils"
import type {
	DashboardDocument,
	DashboardWidget,
	WidgetTimeRange,
} from "../../../lib/api"

const TIME_OPTIONS: TimeRangeKey[] = ["1h", "24h", "7d", "30d"]

function defaultTimeIndex(timeRange: WidgetTimeRange): number {
	if (timeRange.type !== "relative") return 1
	const idx = TIME_OPTIONS.indexOf(timeRange.value as TimeRangeKey)
	return idx >= 0 ? idx : 1
}

function sortWidgets(widgets: readonly DashboardWidget[]): DashboardWidget[] {
	return [...widgets].sort((a, b) => {
		if (a.layout.y !== b.layout.y) return a.layout.y - b.layout.y
		return a.layout.x - b.layout.x
	})
}

type WidgetRow =
	| { kind: "single"; widget: DashboardWidget }
	| { kind: "stat-pair"; widgets: [DashboardWidget, DashboardWidget] }

function buildRows(widgets: DashboardWidget[]): WidgetRow[] {
	const rows: WidgetRow[] = []
	let i = 0
	while (i < widgets.length) {
		const w = widgets[i]
		const next = widgets[i + 1]
		if (w.visualization === "stat" && next?.visualization === "stat") {
			rows.push({ kind: "stat-pair", widgets: [w, next] })
			i += 2
		} else {
			rows.push({ kind: "single", widget: w })
			i += 1
		}
	}
	return rows
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
	const router = useRouter()
	const widgets = sortWidgets(dashboard.widgets)
	const rows = useMemo(() => buildRows(widgets), [widgets])

	const [selectedIndex, setSelectedIndex] = useState(() =>
		defaultTimeIndex(dashboard.timeRange),
	)
	const timeKey = TIME_OPTIONS[selectedIndex]

	const effectiveTimeRange = useMemo<WidgetTimeRange>(
		() => ({ type: "relative", value: timeKey }),
		[timeKey],
	)

	return (
		<View className="flex-1 bg-background">
			{/* Header */}
			<View className="px-5 pt-16 pb-3">
				<Pressable
					onPress={() => router.back()}
					className="flex-row items-center mb-2"
					hitSlop={8}
				>
					<Text className="text-sm text-primary font-mono">← Dashboards</Text>
				</Pressable>
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
				<Text className="text-[10px] text-muted-foreground font-mono mt-2">
					{widgets.length} widget{widgets.length === 1 ? "" : "s"}
				</Text>
			</View>

			{/* Time Range Picker */}
			<View className="px-5 pb-4">
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
					{rows.map((row, idx) => {
						if (row.kind === "stat-pair") {
							const [a, b] = row.widgets
							return (
								<View
									key={`row-${idx}`}
									className="px-5 pb-3 flex-row"
									style={{ gap: 12 }}
								>
									<View style={{ flex: 1 }}>
										<DashboardWidgetView
											widget={a}
											timeRange={effectiveTimeRange}
											compact
										/>
									</View>
									<View style={{ flex: 1 }}>
										<DashboardWidgetView
											widget={b}
											timeRange={effectiveTimeRange}
											compact
										/>
									</View>
								</View>
							)
						}
						return (
							<View key={row.widget.id} className="px-5 pb-3">
								<DashboardWidgetView
									widget={row.widget}
									timeRange={effectiveTimeRange}
								/>
							</View>
						)
					})}
				</ScrollView>
			)}
		</View>
	)
}
