import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native"
import { Link } from "expo-router"
import { useDashboards } from "../../../hooks/use-dashboards"
import { formatRelativeTime } from "../../../lib/format"
import type { DashboardDocument } from "../../../lib/api"

export default function DashboardsScreen() {
	const { state, refresh } = useDashboards()

	return (
		<View className="flex-1 bg-background">
			{/* Header */}
			<View className="px-5 pt-16 pb-3">
				<View className="flex-row justify-between items-start">
					<View>
						<Text className="text-2xl font-bold text-foreground font-mono">
							Dashboards
						</Text>
						<Text className="text-xs text-muted-foreground font-mono mt-0.5">
							{state.status === "success"
								? `${state.data.length} dashboard${state.data.length === 1 ? "" : "s"}`
								: "Loading dashboards..."}
						</Text>
					</View>
				</View>
			</View>

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
			) : state.data.length === 0 ? (
				<View className="flex-1 items-center justify-center px-5">
					<Text className="text-sm text-muted-foreground font-mono text-center">
						No dashboards yet.
					</Text>
					<Text className="text-xs text-muted-foreground font-mono text-center mt-2">
						Create one in the web app to view it here.
					</Text>
				</View>
			) : (
				<DashboardsList dashboards={state.data} />
			)}
		</View>
	)
}

function DashboardsList({ dashboards }: { dashboards: DashboardDocument[] }) {
	return (
		<ScrollView
			className="flex-1"
			contentContainerStyle={{ paddingBottom: 100 }}
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
					<View
						className="px-5 py-4"
						style={{ opacity: pressed ? 0.6 : 1 }}
					>
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
