import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ServicesTable } from "@/components/services/services-table"
import { ServicesFilterSidebar } from "@/components/services/services-filter-sidebar"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { LONG_RANGE_PRESET_OPTIONS } from "@/lib/time-utils"

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60

const servicesSearchSchema = Schema.Struct({
	environments: OptionalStringArrayParam,
	commitShas: OptionalStringArrayParam,
	health: Schema.optional(Schema.Literals(["healthy", "degraded", "unhealthy"])),
	...TimeRangeSearchFields,
})

export type ServicesSearchParams = Schema.Schema.Type<typeof servicesSearchSchema>

export const Route = createFileRoute("/services/")({
	component: ServicesPage,
	validateSearch: Schema.toStandardSchemaV1(servicesSearchSchema),
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
							<ServicesTable filters={search} />
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}
