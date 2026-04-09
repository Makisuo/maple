import { useCallback, useMemo, useState } from "react"
import { FlatList, Pressable, ScrollView, Text, View } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useSpanHierarchy } from "../../../hooks/use-span-hierarchy"
import { getHttpInfo } from "../../../lib/api"
import {
	HTTP_METHOD_COLORS,
	getStatusBgColor,
	getStatusColor,
} from "../../../lib/colors"
import { colors } from "../../../lib/theme"
import { formatDuration } from "../../../lib/format"
import { flattenSpanTree, collectExpandedIds } from "../../../lib/span-tree"
import { SpanRowDetail } from "../../../components/traces/span-row-detail"
import { Screen, useScreenBottomPadding } from "../../../components/ui/screen"
import { ScreenHeader } from "../../../components/ui/screen-header"
import {
	EmptyView,
	ErrorView,
	LoadingView,
} from "../../../components/ui/state-view"

type Tab = "waterfall" | "details" | "logs"

export default function TraceDetailScreen() {
	const { traceId } = useLocalSearchParams<{ traceId: string }>()
	const router = useRouter()
	const { state, refresh } = useSpanHierarchy(traceId)
	const [activeTab, setActiveTab] = useState<Tab>("waterfall")
	const [expandedSpans, setExpandedSpans] = useState<Set<string> | null>(null)
	const bottomPadding = useScreenBottomPadding()

	const resolvedExpanded = useMemo(() => {
		if (state.status !== "success") return new Set<string>()
		if (expandedSpans !== null) return expandedSpans
		return collectExpandedIds(state.data.rootSpans, 2)
	}, [state, expandedSpans])

	const flatSpans = useMemo(() => {
		if (state.status !== "success") return []
		return flattenSpanTree(state.data.rootSpans, resolvedExpanded)
	}, [state, resolvedExpanded])

	const toggleSpan = useCallback(
		(spanId: string) => {
			setExpandedSpans((prev) => {
				const next = new Set(prev ?? resolvedExpanded)
				if (next.has(spanId)) {
					next.delete(spanId)
				} else {
					next.add(spanId)
				}
				return next
			})
		},
		[resolvedExpanded],
	)

	const headerInfo = useMemo(() => {
		if (state.status !== "success" || state.data.rootSpans.length === 0) return null
		const root = state.data.rootSpans[0]
		const http = getHttpInfo(root.spanName, root.spanAttributes)
		const httpStatusCode =
			root.spanAttributes["http.status_code"] ||
			root.spanAttributes["http.response.status_code"]
		const statusCode = httpStatusCode ? parseInt(httpStatusCode, 10) : null
		return {
			method: http?.method ?? null,
			route: http?.route ?? root.spanName,
			traceId: root.traceId,
			durationMs: state.data.totalDurationMs,
			spanCount: state.data.spans.length,
			statusCode,
			hasError: root.statusCode === "Error",
		}
	}, [state])

	return (
		<Screen>
			<ScreenHeader
				title={headerInfo?.route ?? "Trace"}
				backLabel="Traces"
				onBack={() => router.back()}
			/>

			{headerInfo ? (
				<View className="px-5 pb-3">
					{headerInfo.method ? (
						<View className="flex-row items-center mb-2">
							<View
								className="rounded px-2 py-1 mr-2"
								style={{
									backgroundColor:
										HTTP_METHOD_COLORS[headerInfo.method] ?? "#5A5248",
								}}
							>
								<Text className="text-xs font-bold text-white font-mono">
									{headerInfo.method}
								</Text>
							</View>
						</View>
					) : null}

					<View className="flex-row flex-wrap gap-2">
						<Pill label={headerInfo.traceId.slice(0, 12)} />
						<Pill label={formatDuration(headerInfo.durationMs)} />
						<Pill label={`${headerInfo.spanCount} spans`} />
						{headerInfo.statusCode != null ? (
							<View
								className="rounded px-2.5 py-1"
								style={{
									backgroundColor: getStatusBgColor(
										headerInfo.statusCode,
										headerInfo.hasError,
									),
								}}
							>
								<Text
									className="text-xs font-bold font-mono"
									style={{
										color: getStatusColor(
											headerInfo.statusCode,
											headerInfo.hasError,
										),
									}}
								>
									{headerInfo.statusCode}
								</Text>
							</View>
						) : null}
					</View>
				</View>
			) : null}

			<View className="flex-row px-5 border-b border-border">
				<TabButton
					label="Waterfall"
					active={activeTab === "waterfall"}
					onPress={() => setActiveTab("waterfall")}
				/>
				<TabButton
					label="Details"
					active={activeTab === "details"}
					onPress={() => setActiveTab("details")}
				/>
				<TabButton
					label="Logs"
					active={activeTab === "logs"}
					onPress={() => setActiveTab("logs")}
				/>
			</View>

			{state.status === "loading" ? (
				<LoadingView />
			) : state.status === "error" ? (
				<ErrorView message={state.error} onRetry={refresh} />
			) : activeTab === "waterfall" ? (
				<FlatList
					data={flatSpans}
					keyExtractor={(item) => item.spanId}
					contentContainerStyle={{ paddingBottom: bottomPadding }}
					ItemSeparatorComponent={() => <View className="h-px bg-border ml-5" />}
					renderItem={({ item }) => (
						<SpanRowDetail
							span={item}
							isExpanded={resolvedExpanded.has(item.spanId)}
							onToggle={() => toggleSpan(item.spanId)}
							totalDurationMs={state.data.totalDurationMs}
							traceStartTime={state.data.traceStartTime}
						/>
					)}
				/>
			) : activeTab === "details" ? (
				<DetailsTab rootSpans={state.data.rootSpans} />
			) : (
				<EmptyView title="No logs available" />
			)}
		</Screen>
	)
}

function Pill({ label }: { label: string }) {
	return (
		<View
			className="rounded px-2.5 py-1"
			style={{ backgroundColor: "rgba(255,255,255,0.08)" }}
		>
			<Text className="text-xs text-muted-foreground font-mono">{label}</Text>
		</View>
	)
}

function TabButton({
	label,
	active,
	onPress,
}: {
	label: string
	active: boolean
	onPress: () => void
}) {
	return (
		<Pressable onPress={onPress} className="mr-5 pb-2.5">
			<Text
				className={`text-sm font-mono ${active ? "text-foreground font-medium" : "text-muted-foreground"}`}
			>
				{label}
			</Text>
			{active && (
				<View
					className="h-0.5 rounded-full mt-1.5"
					style={{ backgroundColor: colors.primary }}
				/>
			)}
		</Pressable>
	)
}

function DetailsTab({
	rootSpans,
}: {
	rootSpans: import("../../../lib/api").SpanNode[]
}) {
	const bottomPadding = useScreenBottomPadding()
	if (rootSpans.length === 0) return null
	const root = rootSpans[0]
	const spanAttrs = Object.entries(root.spanAttributes)
	const resourceAttrs = Object.entries(root.resourceAttributes)

	return (
		<ScrollView
			className="flex-1"
			contentContainerStyle={{ paddingBottom: bottomPadding }}
		>
			{spanAttrs.length > 0 && (
				<View className="px-5 pt-4">
					<Text className="text-xs font-bold text-muted-foreground font-mono mb-2 uppercase">
						Span Attributes
					</Text>
					{spanAttrs.map(([key, value]) => (
						<View key={key} className="flex-row py-1.5">
							<Text
								className="text-xs text-muted-foreground font-mono w-2/5"
								numberOfLines={1}
							>
								{key}
							</Text>
							<Text
								className="text-xs text-foreground font-mono flex-1"
								numberOfLines={2}
							>
								{value}
							</Text>
						</View>
					))}
				</View>
			)}
			{resourceAttrs.length > 0 && (
				<View className="px-5 pt-4">
					<Text className="text-xs font-bold text-muted-foreground font-mono mb-2 uppercase">
						Resource Attributes
					</Text>
					{resourceAttrs.map(([key, value]) => (
						<View key={key} className="flex-row py-1.5">
							<Text
								className="text-xs text-muted-foreground font-mono w-2/5"
								numberOfLines={1}
							>
								{key}
							</Text>
							<Text
								className="text-xs text-foreground font-mono flex-1"
								numberOfLines={2}
							>
								{value}
							</Text>
						</View>
					))}
				</View>
			)}
		</ScrollView>
	)
}
