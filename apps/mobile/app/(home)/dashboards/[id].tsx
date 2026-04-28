import { useMemo, useState } from "react"
import { ScrollView, View } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useDashboards } from "../../../hooks/use-dashboards"
import { DashboardWidgetView } from "../../../components/dashboards/dashboard-widget-view"
import { Screen, useScreenBottomPadding } from "../../../components/ui/screen"
import { ScreenHeader } from "../../../components/ui/screen-header"
import { TimeRangePicker } from "../../../components/ui/time-range-picker"
import { EmptyView, ErrorView, LoadingView } from "../../../components/ui/state-view"
import type { TimeRangeKey } from "../../../lib/time-utils"
import type { DashboardDocument, DashboardWidget, WidgetTimeRange } from "../../../lib/api"

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
	const router = useRouter()
	const { state, refresh } = useDashboards()

	if (state.status === "loading") {
		return (
			<Screen>
				<LoadingView />
			</Screen>
		)
	}

	if (state.status === "error") {
		return (
			<Screen>
				<ErrorView message={state.error} onRetry={refresh} />
			</Screen>
		)
	}

	const dashboard = state.data.find((d) => d.id === id)
	if (!dashboard) {
		return (
			<Screen>
				<ScreenHeader title="Dashboard" backLabel="Dashboards" onBack={() => router.back()} />
				<EmptyView title="Dashboard not found." />
			</Screen>
		)
	}

	return <DashboardDetailContent dashboard={dashboard} />
}

function DashboardDetailContent({ dashboard }: { dashboard: DashboardDocument }) {
	const router = useRouter()
	const widgets = sortWidgets(dashboard.widgets)
	const rows = useMemo(() => buildRows(widgets), [widgets])
	const bottomPadding = useScreenBottomPadding()

	const [selectedIndex, setSelectedIndex] = useState(() => defaultTimeIndex(dashboard.timeRange))
	const timeKey = TIME_OPTIONS[selectedIndex]

	const effectiveTimeRange = useMemo<WidgetTimeRange>(
		() => ({ type: "relative", value: timeKey }),
		[timeKey],
	)

	const subtitleParts: string[] = []
	if (dashboard.description) subtitleParts.push(dashboard.description)
	subtitleParts.push(`${widgets.length} widget${widgets.length === 1 ? "" : "s"}`)

	return (
		<Screen>
			<ScreenHeader
				title={dashboard.name}
				subtitle={subtitleParts.join(" · ")}
				backLabel="Dashboards"
				onBack={() => router.back()}
			/>

			<TimeRangePicker
				selectedIndex={selectedIndex}
				onChange={setSelectedIndex}
				options={TIME_OPTIONS}
			/>

			{widgets.length === 0 ? (
				<EmptyView title="This dashboard has no widgets." />
			) : (
				<ScrollView
					className="flex-1"
					contentContainerStyle={{ paddingTop: 4, paddingBottom: bottomPadding }}
				>
					{rows.map((row, idx) => {
						if (row.kind === "stat-pair") {
							const [a, b] = row.widgets
							return (
								<View key={`row-${idx}`} className="px-5 pb-3 flex-row" style={{ gap: 12 }}>
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
								<DashboardWidgetView widget={row.widget} timeRange={effectiveTimeRange} />
							</View>
						)
					})}
				</ScrollView>
			)}
		</Screen>
	)
}
