import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ServicesTable } from "@/components/services/services-table"
import { ServicesFilterSidebar } from "@/components/services/services-filter-sidebar"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"

const servicesSearchSchema = Schema.Struct({
	environments: OptionalStringArrayParam,
	commitShas: OptionalStringArrayParam,
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
})

export type ServicesSearchParams = Schema.Schema.Type<typeof servicesSearchSchema>

export const Route = effectRoute(createFileRoute("/services/"))({
	component: ServicesPage,
	validateSearch: Schema.toStandardSchemaV1(servicesSearchSchema),
})

export function ServicesPage() {
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
			<DashboardLayout
				breadcrumbs={[{ label: "Services" }]}
				title="Services"
				description="Overview of all services with key metrics."
				filterSidebar={<ServicesFilterSidebar />}
				headerActions={
					<TimeRangeHeaderControls
						startTime={search.startTime ?? effectiveStartTime}
						endTime={search.endTime ?? effectiveEndTime}
						presetValue={search.timePreset ?? "12h"}
						onTimeChange={handleTimeChange}
					/>
				}
			>
				<ServicesTable filters={search} />
			</DashboardLayout>
		</PageRefreshProvider>
	)
}
