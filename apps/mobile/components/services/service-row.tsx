import { Pressable, Text, View } from "react-native"
import { Link } from "expo-router"
import type { ServiceOverview } from "../../lib/api"
import { SparklineBars } from "../SparklineBars"

function formatLatency(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
	return `${Math.round(ms)}ms`
}

function formatThroughput(rps: number): string {
	if (rps >= 1000) return `${(rps / 1000).toFixed(1)}k/s`
	return `${rps.toFixed(1)}/s`
}

function formatErrorRate(pct: number): string {
	if (pct >= 10) return `${Math.round(pct)}%`
	return `${pct.toFixed(1)}%`
}

function getErrorColor(errorRate: number): string {
	if (errorRate >= 5) return "#c45a3c"
	if (errorRate >= 1) return "#d4873b"
	return "#5cb88a"
}

function getErrorBgColor(errorRate: number): string {
	if (errorRate >= 5) return "rgba(196, 90, 60, 0.2)"
	if (errorRate >= 1) return "rgba(212, 135, 59, 0.2)"
	return "rgba(92, 184, 138, 0.2)"
}

export function ServiceRow({
	service,
	sparklineData,
}: {
	service: ServiceOverview
	sparklineData?: number[]
}) {
	const errorColor = getErrorColor(service.errorRate)
	const errorBgColor = getErrorBgColor(service.errorRate)

	return (
		<Link href={`/(home)/services/${encodeURIComponent(service.serviceName)}`} asChild>
			<Pressable className="px-5 py-3">
				{/* Row 1: Service name + Error rate pill */}
				<View className="flex-row justify-between items-center">
					<Text className="text-sm font-semibold text-foreground font-mono" numberOfLines={1}>
						{service.serviceName}
					</Text>
					<View className="rounded px-1.5 py-0.5 ml-3" style={{ backgroundColor: errorBgColor }}>
						<Text className="text-[10px] font-semibold font-mono" style={{ color: errorColor }}>
							{formatErrorRate(service.errorRate)}
						</Text>
					</View>
				</View>

				{/* Row 2: P95 (amber) · throughput · p50 · p99 */}
				<View className="flex-row items-center mt-1.5">
					<Text className="text-xs font-mono" style={{ color: "#d4873b" }}>
						{formatLatency(service.p95LatencyMs)}
					</Text>
					<Text className="text-xs text-muted-foreground font-mono mx-1">·</Text>
					<Text className="text-xs text-muted-foreground font-mono">
						{formatThroughput(service.throughput)}
					</Text>
					<Text className="text-xs text-muted-foreground font-mono mx-1">·</Text>
					<Text className="text-xs text-muted-foreground font-mono">
						p50 {formatLatency(service.p50LatencyMs)}
					</Text>
					<Text className="text-xs text-muted-foreground font-mono mx-1">·</Text>
					<Text className="text-xs text-muted-foreground font-mono">
						p99 {formatLatency(service.p99LatencyMs)}
					</Text>
				</View>

				{/* Row 3: Sparkline */}
				{sparklineData && sparklineData.length > 0 && (
					<View className="mt-2">
						<SparklineBars
							data={sparklineData}
							color={errorColor}
							height={6}
							barWidth={6}
							gap={2}
						/>
					</View>
				)}
			</Pressable>
		</Link>
	)
}
