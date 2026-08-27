import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { warmAtoms } from "@effect-router/core"
import { Schema } from "effect"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { resolveEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import {
	getCustomChartServiceSparklinesResultAtom,
	getServiceOverviewResultAtom,
	getServicesFacetsResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ServicesTable } from "@/components/services/services-table"
import { ActiveFilterChips } from "@maple/ui/components/filters/active-filter-chips"
import { serviceFilterChips } from "@/lib/services-list/service-filter-chips"
import { ServicesFilterSidebar } from "@/components/services/services-filter-sidebar"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { LONG_RANGE_PRESET_OPTIONS } from "@/lib/time-utils"

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60

const servicesSearchSchema = Schema.Struct({
	environments: OptionalStringArrayParam,
	namespaces: OptionalStringArrayParam,
	commitShas: OptionalStringArrayParam,
	excludedEnvironments: OptionalStringArrayParam,
	excludedNamespaces: OptionalStringArrayParam,
	excludedCommitShas: OptionalStringArrayParam,
	health: Schema.optional(Schema.Literals(["healthy", "degraded", "unhealthy"])),
	// Table grouping mode. Unset = auto: group by namespace when the displayed
	// rows carry any `service.namespace`, else by environment. Render-only —
	// must never be part of an atom input.
	groupBy: Schema.optional(Schema.Literals(["namespace", "environment"])),
	...TimeRangeSearchFields,
})

export type ServicesSearchParams = Schema.Schema.Type<typeof servicesSearchSchema>

/**
 * Atoms the page blocks its first paint on, built from search alone.
 *
 * Exported so the loader and the components cannot drift: the router warms
 * exactly what `ServicesFilterSidebar` and `ServicesTable` go on to read. The
 * inputs must match theirs byte for byte — a mismatch does not fail loudly, it
 * just fetches everything twice.
 *
 * `resolveEffectiveTimeRange` is the same resolver behind `useEffectiveTimeRange`,
 * and it snaps to the cache grid, so a loader firing on hover and a component
 * mounting a moment later land on one entry.
 */
export function servicesRouteAtoms(search: ServicesSearchParams) {
	const { startTime, endTime } = resolveEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)
	const filters = {
		startTime,
		endTime,
		environments: search.environments,
		namespaces: search.namespaces,
		commitShas: search.commitShas,
		excludedEnvironments: search.excludedEnvironments,
		excludedNamespaces: search.excludedNamespaces,
		excludedCommitShas: search.excludedCommitShas,
	}

	return [
		getServicesFacetsResultAtom({ data: { startTime, endTime } }),
		getServiceOverviewResultAtom({ data: filters }),
		getCustomChartServiceSparklinesResultAtom({ data: filters }),
	]
}

export const Route = createFileRoute("/services/")({
	component: ServicesPage,
	validateSearch: Schema.toStandardSchemaV1(servicesSearchSchema),
	loaderDeps: ({ search }) => search,
	// A plain `loader`, not the `effectRoute` wrapper: TanStack's route
	// code-splitting extracts `component` by statically matching
	// `createFileRoute(...)({ ... })`, and it cannot see through a wrapper.
	//
	// `defaultPreload: "intent"` fires this on hover, ahead of the route chunk
	// evaluating and React committing.
	loader: ({ context, deps }) => {
		warmAtoms(context.effectRegistry, servicesRouteAtoms(deps))
	},
})

function ServicesPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
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
			search: (prev: Record<string, unknown>) => applyTimeRangeSearch(prev, range),
		})
	}

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[{ label: "Services" }]} />
				<DashboardLayout.Body>
					<DashboardLayout.Filters>
						<ServicesFilterSidebar />
					</DashboardLayout.Filters>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								title="Services"
								description="Overview of all services with key metrics."
							>
								<TimeRangeHeaderControls
									startTime={search.startTime ?? effectiveStartTime}
									endTime={search.endTime ?? effectiveEndTime}
									presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
									presets={LONG_RANGE_PRESET_OPTIONS}
									maxRangeSeconds={ONE_YEAR_SECONDS}
									onTimeChange={handleTimeChange}
								/>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<ActiveFilterChips
								chips={serviceFilterChips(search).map((chip) => ({
									id: chip.param,
									label: chip.label,
									values: chip.values,
									negated: chip.negated,
									onRemove: () =>
										navigate({
											search: (prev) => ({ ...prev, [chip.param]: undefined }),
										}),
								}))}
							/>
							<ServicesTable filters={search} />
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}
