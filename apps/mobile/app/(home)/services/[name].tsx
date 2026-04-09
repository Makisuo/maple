import { useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { Host, Picker, Text as ExpoText } from "@expo/ui/swift-ui"
import { pickerStyle, tag } from "@expo/ui/swift-ui/modifiers"
import { segmentedTint } from "expo-ui-ext"
import { useServiceDetail, type ServiceDetailData } from "../../../hooks/use-service-detail"
import type { TimeRangeKey } from "../../../lib/time-utils"
import { ChartCard } from "../../../components/services/chart-card"
import { SingleBarChart } from "../../../components/services/single-bar-chart"
import { PercentileBarChart } from "../../../components/services/percentile-bar-chart"

const TIME_OPTIONS: TimeRangeKey[] = ["1h", "24h", "7d", "30d"]

function formatLatency(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
	return `${Math.round(ms)}ms`
}

function formatThroughput(rps: number): string {
	if (rps >= 1000) return `${(rps / 1000).toFixed(1)}k/s`
	return `${rps.toFixed(1)}/s`
}

function formatPercent(rate: number): string {
	if (rate >= 10) return `${Math.round(rate)}%`
	return `${rate.toFixed(1)}%`
}

function SkeletonBlock({ height = 20 }: { height?: number }) {
	return (
		<View
			className="bg-muted rounded-md"
			style={{ height, opacity: 0.4 }}
		/>
	)
}

function ChartSkeleton() {
	return (
		<View className="bg-card rounded-xl border border-border p-4">
			<View className="flex-row justify-between mb-3">
				<SkeletonBlock height={12} />
			</View>
			<SkeletonBlock height={100} />
		</View>
	)
}

export default function ServiceDetailScreen() {
	const { name } = useLocalSearchParams<{ name: string }>()
	const router = useRouter()
	const serviceName = decodeURIComponent(name ?? "")

	const [selectedIndex, setSelectedIndex] = useState(1)
	const timeKey = TIME_OPTIONS[selectedIndex]
	const { state, refresh } = useServiceDetail(serviceName, timeKey)

	return (
		<View className="flex-1 bg-background">
			{/* Header */}
			<View className="px-5 pt-16 pb-3">
				<Pressable onPress={() => router.back()} className="flex-row items-center mb-2">
					<Text className="text-sm text-primary font-mono">← Services</Text>
				</Pressable>
				<Text className="text-2xl font-bold text-foreground font-mono" numberOfLines={1}>
					{serviceName}
				</Text>
			</View>

			{/* Time Range Picker */}
			<View className="px-5 pb-4">
				<Host matchContents={{ vertical: true }} style={{ width: "100%" }}>
					<Picker
						selection={selectedIndex}
						onSelectionChange={(value) => setSelectedIndex(value as number)}
						modifiers={[pickerStyle("segmented"), segmentedTint("#d4873b")]}
					>
						{TIME_OPTIONS.map((option, i) => (
							<ExpoText key={option} modifiers={[tag(i)]}>
								{option}
							</ExpoText>
						))}
					</Picker>
				</Host>
			</View>

			{/* Content */}
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
				<ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 100 }}>
					<View className="px-5 gap-4">
						<ChartSkeleton />
						<ChartSkeleton />
						<ChartSkeleton />
						<ChartSkeleton />
					</View>
				</ScrollView>
			) : (
				<ServiceDetailContent data={state.data} />
			)}
		</View>
	)
}

function ServiceDetailContent({ data }: { data: ServiceDetailData }) {
	const { timeseries, apdex } = data

	const avgP95 =
		timeseries.length > 0
			? timeseries.reduce((sum, p) => sum + p.p95LatencyMs, 0) / timeseries.length
			: 0
	const avgThroughput =
		timeseries.length > 0
			? timeseries.reduce((sum, p) => sum + p.throughput, 0) / timeseries.length
			: 0
	const avgErrorRate =
		timeseries.length > 0
			? timeseries.reduce((sum, p) => sum + p.errorRate, 0) / timeseries.length
			: 0
	const avgApdex =
		apdex.length > 0
			? apdex.reduce((sum, p) => sum + p.apdexScore, 0) / apdex.length
			: 0

	const latencyData = timeseries.map((p) => ({
		bucket: p.bucket,
		p50: p.p50LatencyMs,
		p95: p.p95LatencyMs,
		p99: p.p99LatencyMs,
	}))

	const throughputData = timeseries.map((p) => ({
		bucket: p.bucket,
		value: p.throughput,
	}))

	const errorRateData = timeseries.map((p) => ({
		bucket: p.bucket,
		value: p.errorRate * 100,
	}))

	const apdexData = apdex.map((p) => ({
		bucket: p.bucket,
		value: p.apdexScore,
	}))

	return (
		<ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 100 }}>
			<View className="px-5 gap-4">
				{/* Latency Chart */}
				<ChartCard
					title="Latency"
					summary={
						<Text className="text-sm font-bold font-mono" style={{ color: "#d4873b" }}>
							p95: {formatLatency(avgP95)}
						</Text>
					}
				>
					{latencyData.length > 0 ? (
						<PercentileBarChart data={latencyData} height={120} />
					) : (
						<EmptyChart />
					)}
				</ChartCard>

				{/* Throughput Chart */}
				<ChartCard
					title="Throughput"
					summary={
						<Text className="text-sm font-bold text-foreground font-mono">
							{formatThroughput(avgThroughput)}
						</Text>
					}
				>
					{throughputData.length > 0 ? (
						<SingleBarChart data={throughputData} color="#d4873b" height={120} />
					) : (
						<EmptyChart />
					)}
				</ChartCard>

				{/* Error Rate Chart */}
				<ChartCard
					title="Error Rate"
					summary={
						<Text className="text-sm font-bold font-mono" style={{ color: "#c45a3c" }}>
							{formatPercent(avgErrorRate * 100)}
						</Text>
					}
				>
					{errorRateData.length > 0 ? (
						<SingleBarChart data={errorRateData} color="#c45a3c" height={120} />
					) : (
						<EmptyChart />
					)}
				</ChartCard>

				{/* Apdex Chart */}
				<ChartCard
					title="Apdex"
					summary={
						<Text className="text-sm font-bold font-mono" style={{ color: "#5cb88a" }}>
							{avgApdex.toFixed(2)}
						</Text>
					}
				>
					{apdexData.length > 0 ? (
						<SingleBarChart data={apdexData} color="#5cb88a" height={120} />
					) : (
						<EmptyChart />
					)}
				</ChartCard>
			</View>
		</ScrollView>
	)
}

function EmptyChart() {
	return (
		<View style={{ height: 120, justifyContent: "center", alignItems: "center" }}>
			<Text className="text-xs text-muted-foreground font-mono">No data</Text>
		</View>
	)
}
