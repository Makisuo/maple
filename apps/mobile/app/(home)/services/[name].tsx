import { useState } from "react"
import { ScrollView, Text, View } from "react-native"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useServiceDetail, type ServiceDetailData } from "../../../hooks/use-service-detail"
import type { TimeRangeKey } from "../../../lib/time-utils"
import { colors } from "../../../lib/theme"
import { ChartCard } from "../../../components/services/chart-card"
import { SingleBarChart } from "../../../components/services/single-bar-chart"
import { PercentileBarChart } from "../../../components/services/percentile-bar-chart"
import { Screen, useScreenBottomPadding } from "../../../components/ui/screen"
import { ScreenHeader } from "../../../components/ui/screen-header"
import { TimeRangePicker } from "../../../components/ui/time-range-picker"
import { ErrorView } from "../../../components/ui/state-view"
import { ChartSkeleton } from "../../../components/ui/skeleton"

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
	const pct = rate * 100
	if (pct >= 10) return `${Math.round(pct)}%`
	return `${pct.toFixed(1)}%`
}

export default function ServiceDetailScreen() {
	const { name } = useLocalSearchParams<{ name: string }>()
	const router = useRouter()
	const serviceName = decodeURIComponent(name ?? "")

	const [selectedIndex, setSelectedIndex] = useState(1)
	const timeKey = TIME_OPTIONS[selectedIndex]
	const { state, refresh, isRefreshing } = useServiceDetail(serviceName, timeKey)

	const bottomPadding = useScreenBottomPadding()

	return (
		<Screen>
			<ScreenHeader
				title={serviceName}
				backLabel="Services"
				onBack={() => router.back()}
				isRefreshing={isRefreshing}
			/>

			<TimeRangePicker
				selectedIndex={selectedIndex}
				onChange={setSelectedIndex}
				options={TIME_OPTIONS}
			/>

			{state.status === "error" ? (
				<ErrorView message={state.error} onRetry={refresh} />
			) : state.status === "loading" ? (
				<ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: bottomPadding }}>
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
		</Screen>
	)
}

function ServiceDetailContent({ data }: { data: ServiceDetailData }) {
	const { timeseries, apdex } = data
	const bottomPadding = useScreenBottomPadding()

	const avgP95 =
		timeseries.length > 0 ? timeseries.reduce((sum, p) => sum + p.p95LatencyMs, 0) / timeseries.length : 0
	const avgThroughput =
		timeseries.length > 0 ? timeseries.reduce((sum, p) => sum + p.throughput, 0) / timeseries.length : 0
	const hasSamplingData = timeseries.some((p) => p.hasSampling)
	// errorRate from the query engine is a 0–1 ratio; average the per-bucket
	// values and formatPercent handles the display conversion.
	const avgErrorRate =
		timeseries.length > 0 ? timeseries.reduce((sum, p) => sum + p.errorRate, 0) / timeseries.length : 0
	const avgApdex = apdex.length > 0 ? apdex.reduce((sum, p) => sum + p.apdexScore, 0) / apdex.length : 0

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
		value: p.errorRate,
	}))

	const apdexData = apdex.map((p) => ({
		bucket: p.bucket,
		value: p.apdexScore,
	}))

	return (
		<ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: bottomPadding }}>
			<View className="px-5 gap-4">
				<ChartCard
					title="Latency"
					summary={
						<Text className="text-sm font-bold font-mono" style={{ color: colors.primary }}>
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

				<ChartCard
					title="Throughput"
					summary={
						<Text className="text-sm font-bold text-foreground font-mono">
							{hasSamplingData ? "~" : ""}
							{formatThroughput(avgThroughput)}
						</Text>
					}
				>
					{throughputData.length > 0 ? (
						<SingleBarChart data={throughputData} color={colors.primary} height={120} />
					) : (
						<EmptyChart />
					)}
				</ChartCard>

				<ChartCard
					title="Error Rate"
					summary={
						<Text className="text-sm font-bold font-mono" style={{ color: colors.error }}>
							{formatPercent(avgErrorRate)}
						</Text>
					}
				>
					{errorRateData.length > 0 ? (
						<SingleBarChart data={errorRateData} color={colors.error} height={120} />
					) : (
						<EmptyChart />
					)}
				</ChartCard>

				<ChartCard
					title="Apdex"
					summary={
						<Text className="text-sm font-bold font-mono" style={{ color: colors.success }}>
							{avgApdex.toFixed(2)}
						</Text>
					}
				>
					{apdexData.length > 0 ? (
						<SingleBarChart data={apdexData} color={colors.success} height={120} />
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
