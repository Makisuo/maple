import { Text, View } from "react-native"
import type { ServiceOverview } from "../../lib/api"
import { SparklineBars } from "../SparklineBars"

// Generate a deterministic pseudo-random sparkline from the service name + error rate
function generateSparkline(serviceName: string, errorRate: number): number[] {
	let hash = 0
	for (let i = 0; i < serviceName.length; i++) {
		hash = serviceName.charCodeAt(i) + ((hash << 5) - hash)
	}
	const base = Math.max(errorRate, 0.1)
	const points: number[] = []
	for (let i = 0; i < 8; i++) {
		hash = (hash * 16807 + 1) & 0x7fffffff
		const noise = (hash % 100) / 100 // 0-1
		points.push(base * (0.3 + noise * 0.7))
	}
	return points
}

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

export function ServiceRow({ service }: { service: ServiceOverview }) {
	const errorColor = getErrorColor(service.errorRate)
	const errorBgColor = getErrorBgColor(service.errorRate)

	return (
		<View className="px-5 py-3">
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
			<View className="mt-2">
				<SparklineBars
					data={generateSparkline(service.serviceName, service.errorRate)}
					color={errorColor}
					height={6}
					barWidth={6}
					gap={2}
				/>
			</View>
		</View>
	)
}
