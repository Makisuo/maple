import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { useMemo } from "react"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"

import { Result, useAtomRefresh } from "@/lib/effect-atom"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { getServicesFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ServiceMapView } from "@/components/service-map/service-map-view"
import type { DeclutterFocus } from "@/components/service-map/service-map-declutter"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { QueryErrorState } from "@/components/common/query-error-state"
import { LONG_RANGE_PRESET_OPTIONS, snapRangeForCache } from "@/lib/time-utils"

import { formatWarehouseDateTime } from "@maple/query-engine"
// `__all__` is the sentinel for the "All Environments" option. Storing it in the
// URL (rather than clearing the param) keeps an explicit all-environments choice
// sticky, distinct from "no choice → default to production".
const ALL_ENVIRONMENTS = "__all__"
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60

const serviceMapSearchSchema = Schema.Struct({
	view: Schema.optional(Schema.Literals(["2d", "3d"])),
	environment: Schema.optional(Schema.String),
	// Focus mode: dim/hide everything outside a service's neighborhood. Kept in
	// the URL so a focused view is shareable / survives reloads.
	focusService: Schema.optional(Schema.String),
	focusHops: Schema.optional(Schema.Literals([1, 2])),
	focusMode: Schema.optional(Schema.Literals(["dim", "hide"])),
	...TimeRangeSearchFields,
})

export const Route = createFileRoute("/service-map")({
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
	// map's own time range.
	//
	// Snapped: `formatWarehouseDateTime` is second-precision, so an unsnapped
	// `new Date()` minted a distinct atom key on every single mount. The atom's
	// 5-minute `staleTime` could therefore never fire — every visit re-queried
	// facets and leaked another retained atom. Snapping floors the endpoint to the
	// window's cache grid so revisits share one entry.
	const facetsRange = useMemo(() => {
		const end = Date.now()
		return snapRangeForCache({
			startTime: formatWarehouseDateTime(end - 24 * 60 * 60 * 1000),
			endTime: formatWarehouseDateTime(end),
		})
	}, [])
	const facetsAtom = getServicesFacetsResultAtom({ data: facetsRange })
	const facetsResult = useRefreshableAtomValue(facetsAtom)
	const refreshFacets = useAtomRefresh(facetsAtom)

	const environments = Result.builder(facetsResult)
		.onSuccess((response) => response.data.environments)
		.orElse(() => [])
	const facetsReady = Result.isSuccess(facetsResult)
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

	const focus: DeclutterFocus | null = search.focusService
		? {
				serviceId: search.focusService,
				hops: search.focusHops ?? 1,
				mode: search.focusMode ?? "dim",
			}
		: null

	const handleFocusChange = (next: DeclutterFocus | null) => {
		navigate({
			replace: true,
			search: (prev: Record<string, unknown>) => ({
				...prev,
				focusService: next?.serviceId,
				focusHops: next && next.hops !== 1 ? next.hops : undefined,
				focusMode: next && next.mode !== "dim" ? next.mode : undefined,
			}),
		})
	}

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Service Map" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header title="Service Map">
							{/* Wraps, and below the header's side-by-side breakpoint the
							    environment select takes a row of its own: all three controls
							    on one narrow row left it ~70px, and unwrapped they stacked
							    into a ragged two-line block. */}
							<div className="flex flex-wrap items-center gap-2">
								<ToggleGroup
									variant="outline"
									size="sm"
									aria-label="Service map view"
									value={[search.view ?? "2d"]}
									onValueChange={(values) => {
										const view = values[0]
										if (view === "2d" || view === "3d")
											void navigate({ search: (prev) => ({ ...prev, view }) })
									}}
								>
									<ToggleGroupItem value="2d" aria-label="2D map">
										2D
									</ToggleGroupItem>
									<ToggleGroupItem value="3d" aria-label="3D map">
										3D
									</ToggleGroupItem>
								</ToggleGroup>
								<Select
									items={environmentItems}
									value={selectedEnvironment}
									onValueChange={handleEnvironmentChange}
								>
									<SelectTrigger
										size="sm"
										className="w-full min-w-0 @2xl/page:w-auto @2xl/page:min-w-36"
									>
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
									presets={LONG_RANGE_PRESET_OPTIONS}
									maxRangeSeconds={ONE_YEAR_SECONDS}
									onTimeChange={handleTimeChange}
								/>
							</div>
						</DashboardLayout.Header>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						{Result.isFailure(facetsResult) ? (
							<QueryErrorState
								error={facetsResult.cause}
								titleOverride="Failed to load service environments"
								onRetry={refreshFacets}
							/>
						) : (
							<div className="-mx-4 -mb-4 h-[calc(100vh-10rem)]">
								<ServiceMapView
									viewMode={search.view ?? "2d"}
									startTime={effectiveStartTime}
									endTime={effectiveEndTime}
									deploymentEnv={deploymentEnv}
									focus={focus}
									onFocusChange={handleFocusChange}
								/>
							</div>
						)}
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
