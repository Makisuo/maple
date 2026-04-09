import { Pressable, ScrollView, Text, View } from "react-native"
import { Link } from "expo-router"
import { useDashboards } from "../../../hooks/use-dashboards"
import { formatRelativeTime } from "../../../lib/format"
import { Screen, useScreenBottomPadding } from "../../../components/ui/screen"
import { ScreenHeader } from "../../../components/ui/screen-header"
import {
	EmptyView,
	ErrorView,
	LoadingView,
} from "../../../components/ui/state-view"
import type { DashboardDocument } from "../../../lib/api"

export default function DashboardsScreen() {
	const { state, refresh } = useDashboards()

	const subtitle =
		state.status === "success"
			? `${state.data.length} dashboard${state.data.length === 1 ? "" : "s"}`
			: "Loading dashboards..."

	return (
		<Screen>
			<ScreenHeader title="Dashboards" subtitle={subtitle} />

			{state.status === "error" ? (
				<ErrorView message={state.error} onRetry={refresh} />
			) : state.status === "loading" ? (
				<LoadingView />
			) : state.data.length === 0 ? (
				<EmptyView
					title="No dashboards yet."
					description="Create one in the web app to view it here."
				/>
			) : (
				<DashboardsList dashboards={state.data} />
			)}
		</Screen>
	)
}

function DashboardsList({ dashboards }: { dashboards: DashboardDocument[] }) {
	const bottomPadding = useScreenBottomPadding()
	return (
		<ScrollView
			className="flex-1"
			contentContainerStyle={{ paddingBottom: bottomPadding }}
		>
			{dashboards.map((dashboard, i) => (
				<View key={dashboard.id}>
					<DashboardRow dashboard={dashboard} />
					{i < dashboards.length - 1 && (
						<View className="h-px bg-border mx-5" />
					)}
				</View>
			))}
		</ScrollView>
	)
}

function DashboardRow({ dashboard }: { dashboard: DashboardDocument }) {
	const widgetCount = dashboard.widgets.length

	return (
		<Link
			href={{
				pathname: "/(home)/dashboards/[id]",
				params: { id: dashboard.id },
			}}
			asChild
		>
			<Pressable>
				{({ pressed }) => (
					<View className="px-5 py-4" style={{ opacity: pressed ? 0.6 : 1 }}>
						<View className="flex-row justify-between items-baseline mb-1">
							<Text
								className="text-base font-bold text-foreground font-mono"
								numberOfLines={1}
								style={{ flex: 1, marginRight: 8 }}
							>
								{dashboard.name}
							</Text>
							<Text className="text-[10px] text-muted-foreground font-mono">
								{formatRelativeTime(dashboard.updatedAt)}
							</Text>
						</View>
						{dashboard.description ? (
							<Text
								className="text-xs text-muted-foreground font-mono mt-0.5"
								numberOfLines={2}
							>
								{dashboard.description}
							</Text>
						) : null}
						<Text className="text-[10px] text-muted-foreground font-mono mt-1.5">
							{widgetCount} widget{widgetCount === 1 ? "" : "s"}
						</Text>
					</View>
				)}
			</Pressable>
		</Link>
	)
}
