import { useState } from "react"
import { Text, View } from "react-native"
import { UserButton } from "@clerk/expo/native"
import { useDashboardData } from "../../hooks/use-dashboard-data"
import type { TimeRangeKey } from "../../lib/time-utils"
import { colors } from "../../lib/theme"
import { SparklineBars } from "../../components/SparklineBars"
import { StackedBarChart } from "../../components/StackedBarChart"
import { Screen } from "../../components/ui/screen"
import { ScreenHeader } from "../../components/ui/screen-header"
import { SectionHeader } from "../../components/ui/section-header"
import { Card } from "../../components/ui/card"
import { TimeRangePicker } from "../../components/ui/time-range-picker"
import { ErrorView } from "../../components/ui/state-view"
import { SkeletonBlock, TelemetrySkeleton } from "../../components/ui/skeleton"

const TIME_OPTIONS: TimeRangeKey[] = ["1h", "24h", "7d", "30d"]

function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
	if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
	return n.toLocaleString()
}

function formatBytes(bytes: number): string {
	if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
	if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
	if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`
	return `${bytes} B`
}

function formatDuration(ms: number): string {
	if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`
	return `${Math.round(ms)}ms`
}

function formatPercent(rate: number): string {
	return `${(rate * 100).toFixed(1)}%`
}

function computeChange(current: number, previous: number): string | null {
	if (previous === 0) return null
	const pct = ((current - previous) / previous) * 100
	const sign = pct >= 0 ? "+" : ""
	return `${sign}${pct.toFixed(1)}%`
}

function TelemetryRow({
	label,
	value,
	change,
	sparklineData,
	isLast,
}: {
	label: string
	value: string
	change: string | null
	sparklineData?: number[]
	isLast?: boolean
}) {
	return (
		<View
			className={`flex-row items-center px-4 py-3.5 ${isLast ? "" : "border-b border-border"}`}
		>
			<View className="flex-1">
				<Text className="text-xs text-muted-foreground font-mono mb-1">{label}</Text>
				<View className="flex-row items-baseline gap-2">
					<Text className="text-xl font-bold text-foreground font-mono">{value}</Text>
					{change !== null && (
						<Text className="text-xs font-mono" style={{ color: colors.success }}>
							{change}
						</Text>
					)}
				</View>
			</View>
			{sparklineData && sparklineData.length > 0 && (
				<SparklineBars data={sparklineData} height={22} barWidth={4} gap={2} />
			)}
		</View>
	)
}

export default function DashboardScreen() {
	const [selectedIndex, setSelectedIndex] = useState(1)
	const timeKey = TIME_OPTIONS[selectedIndex]
	const { state, refresh } = useDashboardData(timeKey)

	return (
		<Screen scroll>
			{/* Logo / brand bar — unique to Overview */}
			<View className="flex-row justify-between items-center px-5 pb-2">
				<View className="flex-row items-center gap-2.5">
					<View
						className="rounded-md"
						style={{ width: 28, height: 28, backgroundColor: colors.primary }}
					/>
					<Text className="text-xl font-bold text-foreground font-mono">
						Maple
					</Text>
				</View>
				<View className="flex-row items-center gap-3">
					<View className="border border-border rounded-full px-3 py-1">
						<Text className="text-xs text-muted-foreground font-mono">
							production
						</Text>
					</View>
					<View className="w-7 h-7 rounded-full overflow-hidden">
						<UserButton />
					</View>
				</View>
			</View>

			<ScreenHeader title="Overview" />

			<TimeRangePicker
				selectedIndex={selectedIndex}
				onChange={setSelectedIndex}
				options={TIME_OPTIONS}
			/>

			{state.status === "loading" ? (
				<>
					<View className="px-5 pb-5">
						<SectionHeader>Telemetry</SectionHeader>
						<TelemetrySkeleton />
					</View>
					<View className="px-5 pb-5">
						<SectionHeader>Request Volume</SectionHeader>
						<Card>
							<View style={{ height: 180 }}>
								<SkeletonBlock height={180} />
							</View>
						</Card>
					</View>
					<View className="px-5 pb-5">
						<SectionHeader>Health</SectionHeader>
						<View className="flex-row gap-3">
							<View className="flex-1">
								<Card>
									<SkeletonBlock height={50} />
								</Card>
							</View>
							<View className="flex-1">
								<Card>
									<SkeletonBlock height={50} />
								</Card>
							</View>
						</View>
					</View>
				</>
			) : state.status === "error" ? (
				<ErrorView message={state.error} onRetry={refresh} />
			) : (
				<DashboardContent data={state.data} />
			)}
		</Screen>
	)
}

function DashboardContent({
	data,
}: {
	data: import("../../hooks/use-dashboard-data").DashboardData
}) {
	const { usage, prevUsage, timeseries, logsTimeseries } = data

	const logsSparkline = logsTimeseries.map((p) => p.count)
	const tracesSparkline = timeseries.map((p) => p.throughput)

	const totalRequests = timeseries.reduce((sum, p) => sum + p.throughput, 0)
	const chartData = timeseries.map((p) => ({
		bucket: p.bucket,
		primary: Math.round(p.throughput * (1 - p.errorRate)),
		error: Math.round(p.throughput * p.errorRate),
	}))

	const points = timeseries
	const avgErrorRate =
		points.length > 0
			? points.reduce((sum, p) => sum + p.errorRate, 0) / points.length
			: 0
	const avgP95 =
		points.length > 0
			? points.reduce((sum, p) => sum + p.p95LatencyMs, 0) / points.length
			: 0
	const errorSparkline = points.slice(-10).map((p) => p.errorRate)
	const latencySparkline = points.slice(-10).map((p) => p.p95LatencyMs)

	return (
		<>
			{/* Telemetry Section */}
			<View className="px-5 pb-5">
				<SectionHeader>Telemetry</SectionHeader>
				<Card padding="none" bordered={false}>
					<TelemetryRow
						label="Logs"
						value={formatNumber(usage.logs)}
						change={computeChange(usage.logs, prevUsage.logs)}
						sparklineData={logsSparkline}
					/>
					<TelemetryRow
						label="Traces"
						value={formatNumber(usage.traces)}
						change={computeChange(usage.traces, prevUsage.traces)}
						sparklineData={tracesSparkline}
					/>
					<TelemetryRow
						label="Metrics"
						value={formatNumber(usage.metrics)}
						change={computeChange(usage.metrics, prevUsage.metrics)}
					/>
					<TelemetryRow
						label="Data Size"
						value={formatBytes(usage.dataSize)}
						change={computeChange(usage.dataSize, prevUsage.dataSize)}
						isLast
					/>
				</Card>
			</View>

			{/* Request Volume Section */}
			<View className="px-5 pb-5">
				<SectionHeader>Request Volume</SectionHeader>
				<Card>
					<View className="flex-row items-baseline justify-between mb-3">
						<View className="flex-row items-baseline gap-2">
							<Text className="text-xs text-muted-foreground font-mono">Total</Text>
							<Text className="text-xl font-bold text-foreground font-mono">
								{formatNumber(totalRequests)}
							</Text>
						</View>
						<View className="flex-row items-center gap-3">
							<View className="flex-row items-center gap-1">
								<View
									style={{
										width: 6,
										height: 6,
										borderRadius: 3,
										backgroundColor: colors.primary,
									}}
								/>
								<Text className="text-xs text-muted-foreground font-mono">2XX</Text>
							</View>
							<View className="flex-row items-center gap-1">
								<View
									style={{
										width: 6,
										height: 6,
										borderRadius: 3,
										backgroundColor: colors.error,
									}}
								/>
								<Text className="text-xs text-muted-foreground font-mono">5XX</Text>
							</View>
						</View>
					</View>
					{chartData.length > 0 ? (
						<StackedBarChart data={chartData} height={100} />
					) : (
						<View
							style={{ height: 100, justifyContent: "center", alignItems: "center" }}
						>
							<Text className="text-xs text-muted-foreground font-mono">No data</Text>
						</View>
					)}
				</Card>
			</View>

			{/* Health Section */}
			<View className="px-5 pb-5">
				<SectionHeader>Health</SectionHeader>
				<View className="flex-row gap-3">
					<View className="flex-1">
						<Card>
							<View className="flex-row items-baseline justify-between mb-2">
								<Text className="text-xs text-muted-foreground font-mono">
									Error Rate
								</Text>
								<Text
									className="text-lg font-bold font-mono"
									style={{ color: colors.error }}
								>
									{formatPercent(avgErrorRate)}
								</Text>
							</View>
							<SparklineBars
								data={errorSparkline}
								color={colors.error}
								height={36}
								barWidth={10}
								gap={3}
							/>
						</Card>
					</View>
					<View className="flex-1">
						<Card>
							<View className="flex-row items-baseline justify-between mb-2">
								<Text className="text-xs text-muted-foreground font-mono">
									P95 Latency
								</Text>
								<Text
									className="text-lg font-bold font-mono"
									style={{ color: colors.primary }}
								>
									{formatDuration(avgP95)}
								</Text>
							</View>
							<SparklineBars
								data={latencySparkline}
								color={colors.primary}
								height={36}
								barWidth={10}
								gap={3}
							/>
						</Card>
					</View>
				</View>
			</View>
		</>
	)
}
