import { ActivityIndicator, ScrollView, Text, View } from "react-native"
import { useServices } from "../../hooks/use-services"
import { ServiceRow } from "../../components/services/service-row"
import type { ServiceOverview } from "../../lib/api"

const ENV_ORDER = ["production", "staging", "development"]

function envSortKey(env: string): number {
	const idx = ENV_ORDER.indexOf(env.toLowerCase())
	return idx >= 0 ? idx : ENV_ORDER.length
}

function groupByEnvironment(services: ServiceOverview[]): Array<{ environment: string; services: ServiceOverview[] }> {
	const groups = new Map<string, ServiceOverview[]>()

	for (const svc of services) {
		const env = svc.environment
		const group = groups.get(env)
		if (group) {
			group.push(svc)
		} else {
			groups.set(env, [svc])
		}
	}

	return Array.from(groups.entries())
		.sort(([a], [b]) => envSortKey(a) - envSortKey(b))
		.map(([environment, services]) => ({ environment, services }))
}

function formatLatency(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
	return `${Math.round(ms)}ms`
}

function formatPercent(rate: number): string {
	if (rate >= 10) return `${Math.round(rate)}%`
	return `${rate.toFixed(1)}%`
}

export default function ServicesScreen() {
	const { state, refresh } = useServices("24h")

	return (
		<View className="flex-1 bg-background">
			{/* Header */}
			<View className="px-5 pt-16 pb-3">
				<View className="flex-row justify-between items-start">
					<View>
						<Text className="text-2xl font-bold text-foreground font-mono">
							Services
						</Text>
						<Text className="text-xs text-muted-foreground font-mono mt-0.5">
							{state.status === "success"
								? `${state.data.length} services`
								: "Loading services..."}
						</Text>
					</View>
					<View className="flex-row items-center gap-2">
						<View className="rounded-lg border border-border px-3 py-1.5">
							<Text className="text-xs text-foreground font-mono">Last 24h</Text>
						</View>
					</View>
				</View>
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
				<View className="flex-1 items-center justify-center">
					<ActivityIndicator size="small" />
				</View>
			) : (
				<ServicesContent services={state.data} />
			)}
		</View>
	)
}

function ServicesContent({ services }: { services: ServiceOverview[] }) {
	const groups = groupByEnvironment(services)

	const avgErrorRate =
		services.length > 0
			? services.reduce((sum, s) => sum + s.errorRate, 0) / services.length
			: 0
	const avgP95 =
		services.length > 0
			? services.reduce((sum, s) => sum + s.p95LatencyMs, 0) / services.length
			: 0

	return (
		<ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 100 }}>
			{/* Summary Stats Bar */}
			<View className="px-5 pb-4">
				<View className="flex-row bg-card rounded-xl border border-border overflow-hidden">
					<View className="flex-1 items-center py-3.5">
						<Text className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
							Services
						</Text>
						<Text className="text-lg font-bold text-foreground font-mono mt-1">
							{services.length}
						</Text>
					</View>
					<View className="w-px bg-border" />
					<View className="flex-1 items-center py-3.5">
						<Text className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
							Err Rate
						</Text>
						<Text className="text-lg font-bold font-mono mt-1" style={{ color: "#c45a3c" }}>
							{formatPercent(avgErrorRate)}
						</Text>
					</View>
					<View className="w-px bg-border" />
					<View className="flex-1 items-center py-3.5">
						<Text className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
							P95
						</Text>
						<Text className="text-lg font-bold font-mono mt-1" style={{ color: "#d4873b" }}>
							{formatLatency(avgP95)}
						</Text>
					</View>
				</View>
			</View>

			{/* Service List grouped by environment */}
			{groups.map(({ environment, services: envServices }) => (
				<View key={environment}>
					{/* Section Header */}
					<View className="px-5 pt-4 pb-2">
						<Text className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
							{environment} — {envServices.length}
						</Text>
					</View>

					{/* Service Rows */}
					{envServices.map((service, i) => (
						<View key={`${service.serviceName}::${service.environment}`}>
							<ServiceRow service={service} />
							{i < envServices.length - 1 && (
								<View className="h-px bg-border mx-5" />
							)}
						</View>
					))}
				</View>
			))}
		</ScrollView>
	)
}
