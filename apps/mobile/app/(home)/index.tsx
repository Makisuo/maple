import { useState } from "react"
import { ScrollView, Text, View } from "react-native"
import { UserButton } from "@clerk/expo/native"
import { Host, Picker, Text as ExpoText } from "@expo/ui/swift-ui"
import { pickerStyle, tag } from "@expo/ui/swift-ui/modifiers"
import { useDashboardData } from "../../hooks/use-dashboard-data"
import type { TimeRangeKey } from "../../lib/time-utils"
import { SparklineBars } from "../../components/SparklineBars"
import { StackedBarChart } from "../../components/StackedBarChart"

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
  sparklineData: number[]
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
            <Text className="text-xs font-mono" style={{ color: "#5cb88a" }}>
              {change}
            </Text>
          )}
        </View>
      </View>
      <SparklineBars data={sparklineData} height={22} barWidth={4} gap={2} />
    </View>
  )
}

function SkeletonBlock({ height = 20 }: { height?: number }) {
  return (
    <View
      className="bg-muted rounded-md"
      style={{ height, opacity: 0.4 }}
    />
  )
}

function TelemetrySkeleton() {
  return (
    <View className="bg-card rounded-xl overflow-hidden">
      {[0, 1, 2, 3].map((i) => (
        <View
          key={i}
          className={`px-4 py-3.5 ${i < 3 ? "border-b border-border" : ""}`}
        >
          <SkeletonBlock height={12} />
          <View style={{ height: 6 }} />
          <SkeletonBlock height={24} />
        </View>
      ))}
    </View>
  )
}

export default function DashboardScreen() {
  const [selectedIndex, setSelectedIndex] = useState(1)
  const timeKey = TIME_OPTIONS[selectedIndex]
  const { state } = useDashboardData(timeKey)

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 100 }}
      >
        {/* Header */}
        <View className="flex-row justify-between items-center px-5 pt-16 pb-2">
          <View className="flex-row items-center gap-2.5">
            <View
              className="rounded-md"
              style={{ width: 28, height: 28, backgroundColor: "#d4873b" }}
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

        {/* Title */}
        <View className="px-5 pb-3">
          <Text className="text-3xl font-bold text-foreground font-mono">
            Overview
          </Text>
        </View>

        {/* Time Range Segment Control */}
        <View className="px-5 pb-5">
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

        {state.status === "loading" ? (
          <>
            <View className="px-5 pb-5">
              <Text className="text-xs text-muted-foreground font-mono uppercase tracking-widest mb-2 px-1">
                Telemetry
              </Text>
              <TelemetrySkeleton />
            </View>
            <View className="px-5 pb-5">
              <Text className="text-xs text-muted-foreground font-mono uppercase tracking-widest mb-2 px-1">
                Request Volume
              </Text>
              <View className="bg-card rounded-xl p-4" style={{ height: 200 }}>
                <SkeletonBlock height={180} />
              </View>
            </View>
            <View className="px-5 pb-5">
              <Text className="text-xs text-muted-foreground font-mono uppercase tracking-widest mb-2 px-1">
                Health
              </Text>
              <View className="flex-row gap-3">
                <View className="flex-1 bg-card rounded-xl p-4"><SkeletonBlock height={50} /></View>
                <View className="flex-1 bg-card rounded-xl p-4"><SkeletonBlock height={50} /></View>
              </View>
            </View>
          </>
        ) : state.status === "error" ? (
          <View className="px-5">
            <View className="bg-card rounded-xl p-4">
              <Text className="text-sm text-muted-foreground font-mono">
                Unable to load dashboard data
              </Text>
              <Text className="text-xs text-muted-foreground font-mono mt-1">
                {state.error}
              </Text>
            </View>
          </View>
        ) : (
          <DashboardContent data={state.data} />
        )}
      </ScrollView>
    </View>
  )
}

function DashboardContent({ data }: { data: import("../../hooks/use-dashboard-data").DashboardData }) {
  const { usage, prevUsage, usagePerService, timeseries } = data

  const makeSparkline = (getter: (s: import("../../lib/api").ServiceUsage) => number) => {
    const values = usagePerService.map(getter)
    while (values.length < 6) values.push(0)
    return values.slice(0, 6)
  }

  const totalRequests = timeseries.reduce((sum, p) => sum + p.throughput, 0)
  const chartData = timeseries.map((p) => ({
    bucket: p.bucket,
    primary: Math.round(p.throughput * (1 - p.errorRate)),
    error: Math.round(p.throughput * p.errorRate),
  }))

  const points = timeseries
  const avgErrorRate = points.length > 0
    ? points.reduce((sum, p) => sum + p.errorRate, 0) / points.length
    : 0
  const avgP95 = points.length > 0
    ? points.reduce((sum, p) => sum + p.p95LatencyMs, 0) / points.length
    : 0
  const errorSparkline = points.slice(-10).map((p) => p.errorRate)
  const latencySparkline = points.slice(-10).map((p) => p.p95LatencyMs)

  return (
    <>
      {/* Telemetry Section */}
      <View className="px-5 pb-5">
        <Text className="text-xs text-muted-foreground font-mono uppercase tracking-widest mb-2 px-1">
          Telemetry
        </Text>
        <View className="bg-card rounded-xl overflow-hidden">
          <TelemetryRow
            label="Logs"
            value={formatNumber(usage.logs)}
            change={computeChange(usage.logs, prevUsage.logs)}
            sparklineData={makeSparkline((s) => s.totalLogs)}
          />
          <TelemetryRow
            label="Traces"
            value={formatNumber(usage.traces)}
            change={computeChange(usage.traces, prevUsage.traces)}
            sparklineData={makeSparkline((s) => s.totalTraces)}
          />
          <TelemetryRow
            label="Metrics"
            value={formatNumber(usage.metrics)}
            change={computeChange(usage.metrics, prevUsage.metrics)}
            sparklineData={makeSparkline((s) => s.totalMetrics)}
          />
          <TelemetryRow
            label="Data Size"
            value={formatBytes(usage.dataSize)}
            change={computeChange(usage.dataSize, prevUsage.dataSize)}
            sparklineData={makeSparkline((s) => s.dataSizeBytes)}
            isLast
          />
        </View>
      </View>

      {/* Request Volume Section */}
      <View className="px-5 pb-5">
        <Text className="text-xs text-muted-foreground font-mono uppercase tracking-widest mb-2 px-1">
          Request Volume
        </Text>
        <View className="bg-card rounded-xl p-4">
          <View className="flex-row items-baseline justify-between mb-3">
            <View className="flex-row items-baseline gap-2">
              <Text className="text-xs text-muted-foreground font-mono">Total</Text>
              <Text className="text-xl font-bold text-foreground font-mono">
                {formatNumber(totalRequests)}
              </Text>
            </View>
            <View className="flex-row items-center gap-3">
              <View className="flex-row items-center gap-1">
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#d4873b" }} />
                <Text className="text-xs text-muted-foreground font-mono">2XX</Text>
              </View>
              <View className="flex-row items-center gap-1">
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#c45a3c" }} />
                <Text className="text-xs text-muted-foreground font-mono">5XX</Text>
              </View>
            </View>
          </View>
          {chartData.length > 0 ? (
            <StackedBarChart data={chartData} height={100} />
          ) : (
            <View style={{ height: 100, justifyContent: "center", alignItems: "center" }}>
              <Text className="text-xs text-muted-foreground font-mono">No data</Text>
            </View>
          )}
        </View>
      </View>

      {/* Health Section */}
      <View className="px-5 pb-5">
        <Text className="text-xs text-muted-foreground font-mono uppercase tracking-widest mb-2 px-1">
          Health
        </Text>
        <View className="flex-row gap-3">
          <View className="flex-1 bg-card rounded-xl p-4">
            <View className="flex-row items-baseline justify-between mb-2">
              <Text className="text-xs text-muted-foreground font-mono">Error Rate</Text>
              <Text className="text-lg font-bold font-mono" style={{ color: "#c45a3c" }}>
                {formatPercent(avgErrorRate)}
              </Text>
            </View>
            <SparklineBars data={errorSparkline} color="#c45a3c" height={36} barWidth={10} gap={3} />
          </View>
          <View className="flex-1 bg-card rounded-xl p-4">
            <View className="flex-row items-baseline justify-between mb-2">
              <Text className="text-xs text-muted-foreground font-mono">P95 Latency</Text>
              <Text className="text-lg font-bold font-mono" style={{ color: "#d4873b" }}>
                {formatDuration(avgP95)}
              </Text>
            </View>
            <SparklineBars data={latencySparkline} color="#d4873b" height={36} barWidth={10} gap={3} />
          </View>
        </View>
      </View>
    </>
  )
}
