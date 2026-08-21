import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { BooleanFromStringParam, OptionalStringArrayParam } from "@/lib/search-params"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ErrorsFilterSidebar } from "@/components/errors/errors-filter-sidebar"
import {
	ErrorsHub,
	HUB_SORTS,
	HUB_VIEWS,
	SEVERITY_FILTERS,
	type HubSort,
	type HubView,
	type SeverityFilter,
} from "@/components/errors/errors-hub"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const errorsSearchSchema = Schema.Struct({
	services: OptionalStringArrayParam,
	deploymentEnvs: OptionalStringArrayParam,
	errorTypes: OptionalStringArrayParam,
	serviceVersions: OptionalStringArrayParam,
	showSpam: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	rootOnly: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	view: Schema.optional(Schema.Literals(HUB_VIEWS)),
	sort: Schema.optional(Schema.Literals(HUB_SORTS)),
	severity: Schema.optional(Schema.Literals(SEVERITY_FILTERS)),
	...TimeRangeSearchFields,
})

export type ErrorsSearchParams = Schema.Schema.Type<typeof errorsSearchSchema>

export const Route = createFileRoute("/errors/")({
	component: ErrorsPage,
	validateSearch: Schema.toStandardSchemaV1(errorsSearchSchema),
	// No atoms are warmed here any more. The list is issue-first, and which
	// fingerprints it charts is only known once that page has loaded — warming
	// a warehouse query on hover would fetch a set the page then discards.
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
	const effectiveRange = useEffectiveTimeRange(search.startTime, search.endTime, search.timePreset ?? "12h")

	const handleTimeChange = (
		range: { startTime?: string; endTime?: string; presetValue?: string },
		options?: { replace?: boolean },
	) => {
		navigate({
			replace: options?.replace,
			search: (prev) => applyTimeRangeSearch(prev, range),
		})
	}

	const view: HubView = search.view ?? "open"
	const sort: HubSort = search.sort ?? "volume"
	const severity: SeverityFilter = search.severity ?? "all"

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
							description="Every error fingerprint, with what it is doing and who is on it."
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
						<ErrorsHub
							view={view}
							sort={sort}
							severity={severity}
							range={effectiveRange}
							services={search.services}
							deploymentEnvs={search.deploymentEnvs}
							errorTypes={search.errorTypes}
							serviceVersions={search.serviceVersions}
							rootOnly={search.rootOnly}
							showSpam={search.showSpam}
						/>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
