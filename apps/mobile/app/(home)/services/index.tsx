import { ScrollView, Text, View } from "react-native"
import { useServices, type ServicesData } from "../../../hooks/use-services"
import { ServiceRow } from "../../../components/services/service-row"
import { Screen, useScreenBottomPadding } from "../../../components/ui/screen"
import { ScreenHeader } from "../../../components/ui/screen-header"
import { SectionHeader } from "../../../components/ui/section-header"
import { Card } from "../../../components/ui/card"
import { ErrorView, LoadingView } from "../../../components/ui/state-view"
import { colors } from "../../../lib/theme"
import type { ServiceOverview } from "../../../lib/api"

const ENV_ORDER = ["production", "staging", "development"]

function envSortKey(env: string): number {
	const idx = ENV_ORDER.indexOf(env.toLowerCase())
	return idx >= 0 ? idx : ENV_ORDER.length
}

function groupByEnvironment(
	services: ServiceOverview[],
): Array<{ environment: string; services: ServiceOverview[] }> {
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
	const pct = rate * 100
	if (pct >= 10) return `${Math.round(pct)}%`
	return `${pct.toFixed(1)}%`
}

export default function ServicesScreen() {
	const { state, refresh } = useServices("24h")

	const subtitle =
		state.status === "success" ? `${state.data.services.length} services` : "Loading services..."

	return (
		<Screen>
			<ScreenHeader
				title="Services"
				subtitle={subtitle}
				right={
					<View className="rounded-lg border border-border px-3 py-1.5">
						<Text className="text-xs text-foreground font-mono">Last 24h</Text>
					</View>
				}
			/>

			{state.status === "error" ? (
				<ErrorView message={state.error} onRetry={refresh} />
			) : state.status === "loading" ? (
				<LoadingView />
			) : (
				<ServicesContent data={state.data} />
			)}
		</Screen>
	)
}

function ServicesContent({ data }: { data: ServicesData }) {
	const { services, sparklines } = data
	const groups = groupByEnvironment(services)
	const bottomPadding = useScreenBottomPadding()

	const avgErrorRate =
		services.length > 0 ? services.reduce((sum, s) => sum + s.errorRate, 0) / services.length : 0
	const avgP95 =
		services.length > 0 ? services.reduce((sum, s) => sum + s.p95LatencyMs, 0) / services.length : 0

	return (
		<ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: bottomPadding }}>
			{/* Summary Stats Bar */}
			<View className="px-5 pb-4">
				<Card padding="none">
					<View className="flex-row">
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
							<Text
								className="text-lg font-bold font-mono mt-1"
								style={{ color: colors.error }}
							>
								{formatPercent(avgErrorRate)}
							</Text>
						</View>
						<View className="w-px bg-border" />
						<View className="flex-1 items-center py-3.5">
							<Text className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
								P95
							</Text>
							<Text
								className="text-lg font-bold font-mono mt-1"
								style={{ color: colors.primary }}
							>
								{formatLatency(avgP95)}
							</Text>
						</View>
					</View>
				</Card>
			</View>

			{/* Service List grouped by environment */}
			{groups.map(({ environment, services: envServices }) => (
				<View key={environment}>
					{/* Section Header */}
					<View className="px-5 pt-4">
						<SectionHeader>
							{environment} — {envServices.length}
						</SectionHeader>
					</View>

					{/* Service Rows */}
					{envServices.map((service, i) => (
						<View key={`${service.serviceName}::${service.environment}`}>
							<ServiceRow service={service} sparklineData={sparklines[service.serviceName]} />
							{i < envServices.length - 1 && <View className="h-px bg-border mx-5" />}
						</View>
					))}
				</View>
			))}
		</ScrollView>
	)
}
