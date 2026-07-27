import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { BooleanFromStringParam, OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ErrorsSummaryCards } from "@/components/errors/errors-summary-cards"
import { ErrorsByTypeTable } from "@/components/errors/errors-by-type-table"
import { ErrorsFilterSidebar } from "@/components/errors/errors-filter-sidebar"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const errorsSearchSchema = Schema.Struct({
	services: OptionalStringArrayParam,
	deploymentEnvs: OptionalStringArrayParam,
	errorTypes: OptionalStringArrayParam,
	showSpam: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	rootOnly: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	...TimeRangeSearchFields,
})

export type ErrorsSearchParams = Schema.Schema.Type<typeof errorsSearchSchema>

export const Route = createFileRoute("/errors/")({
	component: ErrorsPage,
	validateSearch: Schema.toStandardSchemaV1(errorsSearchSchema),
})

function ErrorsPage() {
	const search = Route.useSearch()
	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
			<ErrorsContent />
		</PageRefreshProvider>
	)
}

function ErrorsContent() {
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
			search: (prev) => applyTimeRangeSearch(prev, range),
		})
	}

	const apiFilters = {
		startTime: effectiveStartTime,
		endTime: effectiveEndTime,
		services: search.services,
		deploymentEnvs: search.deploymentEnvs,
		errorTypes: search.errorTypes,
		showSpam: search.showSpam,
		rootOnly: search.rootOnly !== false,
	}

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Errors" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Filters>
					<ErrorsFilterSidebar />
				</DashboardLayout.Filters>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							title="Errors"
							description="Monitor and analyze errors across your services."
						>
							<TimeRangeHeaderControls
								startTime={search.startTime}
								endTime={search.endTime}
								presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
								onTimeChange={handleTimeChange}
							/>
						</DashboardLayout.Header>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<div className="space-y-6">
							<ErrorsSummaryCards filters={apiFilters} />
							<div>
								<h2 className="text-lg font-semibold mb-4">Errors by Type</h2>
								<ErrorsByTypeTable filters={apiFilters} />
							</div>
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
