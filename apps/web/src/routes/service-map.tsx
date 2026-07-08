import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"
import { useMemo } from "react"

import { Result } from "@/lib/effect-atom"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { getServicesFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ServiceMapView } from "@/components/service-map/service-map-view"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

// `__all__` is the sentinel for the "All Environments" option. Storing it in the
// URL (rather than clearing the param) keeps an explicit all-environments choice
// sticky, distinct from "no choice → default to production".
const ALL_ENVIRONMENTS = "__all__"

const serviceMapSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
	environment: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/service-map"))({
	component: ServiceMapPage,
	validateSearch: Schema.toStandardSchemaV1(serviceMapSearchSchema),
})

function ServiceMapPage() {
	const search = Route.useSearch()
	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<ServiceMapContent />
		</PageRefreshProvider>
	)
}

function ServiceMapContent() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	// Stable 24h window for the environment dropdown — environments move slowly, so
	// a fixed range keeps this a single cached facets request independent of the
	// map's own time range. Matches the dashboard's facets probe.
	const facetsRange = useMemo(() => {
		const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19)
		const end = new Date()
		const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
		return { startTime: fmt(start), endTime: fmt(end) }
	}, [])
	const facetsResult = useRetainedRefreshableResultValue(getServicesFacetsResultAtom({ data: facetsRange }))

	const environments = Result.builder(facetsResult)
		.onSuccess((response) => response.data.environments)
		.orElse(() => [])
	const facetsReady = !Result.isInitial(facetsResult)
	const hasProduction = environments.some((e) => e.name === "production")

	// Default to production. Before facets resolve, optimistically assume it exists
	// (the common case) so the first map fetch is already prod-scoped rather than
	// loading every environment and then narrowing. Only a confirmed
	// no-production org falls back to all environments.
	const selectedEnvironment =
		search.environment ?? (facetsReady && !hasProduction ? ALL_ENVIRONMENTS : "production")
	const deploymentEnv = selectedEnvironment === ALL_ENVIRONMENTS ? undefined : selectedEnvironment

	const environmentItems = useMemo(
		() => [
			{ value: ALL_ENVIRONMENTS, label: "All Environments" },
			...environments.map((e) => ({ value: e.name, label: e.name })),
		],
		[environments],
	)

	const handleTimeChange = (
		range: {
			startTime?: string
			endTime?: string
			presetValue?: string
		},
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			search: (prev) => applyTimeRangeSearch(prev, range),
		})
	}

	const handleEnvironmentChange = (value: string | null) => {
		navigate({
			search: (prev: Record<string, unknown>) => ({ ...prev, environment: value ?? undefined }),
		})
	}

	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Service Map" }]}
			title="Service Map"
			description="Visualize service-to-service dependencies and data flow."
			headerActions={
				<div className="flex items-center gap-2">
					<Select
						items={environmentItems}
						value={selectedEnvironment}
						onValueChange={handleEnvironmentChange}
					>
						<SelectTrigger size="sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{environmentItems.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<TimeRangeHeaderControls
						startTime={search.startTime}
						endTime={search.endTime}
						presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
						onTimeChange={handleTimeChange}
					/>
				</div>
			}
		>
			<div className="-mx-4 -mb-4 h-[calc(100vh-10rem)]">
				<ServiceMapView
					startTime={effectiveStartTime}
					endTime={effectiveEndTime}
					deploymentEnv={deploymentEnv}
				/>
			</div>
		</DashboardLayout>
	)
}
