import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { warmAtoms } from "@effect-router/core"
import { Schema } from "effect"

import { BooleanFromStringParam, OptionalStringArrayParam } from "@/lib/search-params"
import { resolveEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import {
	getErrorsByTypeResultAtom,
	getErrorsSummaryResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
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

/**
 * Filters shared by the loader and the page, so the atoms warmed on hover are
 * the exact ones `ErrorsSummaryCards` and `ErrorsByTypeTable` go on to read.
 * A mismatch here does not fail loudly — it just fetches everything twice.
 */
function errorsApiFilters(
	search: ErrorsSearchParams,
	range: { startTime: string; endTime: string },
) {
	return {
		startTime: range.startTime,
		endTime: range.endTime,
		services: search.services,
		deploymentEnvs: search.deploymentEnvs,
		errorTypes: search.errorTypes,
		showSpam: search.showSpam,
		rootOnly: search.rootOnly !== false,
	}
}

export const Route = createFileRoute("/errors/")({
	component: ErrorsPage,
	validateSearch: Schema.toStandardSchemaV1(errorsSearchSchema),
	loaderDeps: ({ search }) => search,
	loader: ({ context, deps }) => {
		// The loader has no refresh context, so it resolves the range directly.
		// The component goes through `useEffectiveTimeRange`, which additionally
		// re-resolves against the real clock once the user hits Reload.
		const filters = errorsApiFilters(
			deps,
			resolveEffectiveTimeRange(deps.startTime, deps.endTime, deps.timePreset ?? "12h"),
		)
		warmAtoms(context.effectRegistry, [
			getErrorsSummaryResultAtom({ data: filters }),
			getErrorsByTypeResultAtom({ data: filters }),
		])
	},
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
	const effectiveRange = useEffectiveTimeRange(
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

	// Same builder the loader uses, so hover-warmed atoms and mounted atoms are
	// the same entries.
	const apiFilters = errorsApiFilters(search, effectiveRange)

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
