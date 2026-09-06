import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { IssueKind } from "@maple/domain/http"
import { BooleanFromStringParam } from "@/lib/search-params"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ErrorsFilterSidebar } from "@/components/errors/errors-filter-sidebar"
import {
	ERRORS_WINDOW,
	ErrorsHub,
	HUB_SORTS,
	HUB_VIEWS,
	SEVERITY_FILTERS,
	type HubSort,
	type HubView,
	type SeverityFilter,
} from "@/components/errors/errors-hub"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { ReloadControls } from "@/components/time-range-picker/reload-controls"
import { ActiveFilterChips } from "@maple/ui/components/filters/active-filter-chips"
import { CLEARED_ERROR_FILTERS, errorFilterChips, hasErrorFilters } from "@/lib/errors/error-filter-chips"

/**
 * The list is every issue, newest first, paged, and every param here is one
 * the issues API filters on directly — so a filter narrows the whole list, not
 * a windowed top-N of it. No time range: the only windowed things on the page
 * are the trend, the count and the totals, which look back a fixed
 * `ERRORS_WINDOW`. Old links carrying `timePreset` or the retired facet params
 * decode fine — the struct ignores keys it does not declare.
 */
const errorsSearchSchema = Schema.Struct({
	service: Schema.optional(Schema.String),
	env: Schema.optional(Schema.String),
	kind: Schema.optional(IssueKind),
	regressed: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	view: Schema.optional(Schema.Literals(HUB_VIEWS)),
	sort: Schema.optional(Schema.Literals(HUB_SORTS)),
	severity: Schema.optional(Schema.Literals(SEVERITY_FILTERS)),
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
	return (
		<PageRefreshProvider timePreset={ERRORS_WINDOW}>
			<ErrorsContent />
		</PageRefreshProvider>
	)
}

function ErrorsContent() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const trendWindow = useEffectiveTimeRange(undefined, undefined, ERRORS_WINDOW)

	const activeFilterChips = errorFilterChips(search).map((chip) => ({
		id: chip.param,
		label: chip.label,
		values: chip.values,
		onRemove: () => navigate({ search: (prev) => ({ ...prev, [chip.param]: undefined }) }),
	}))

	const clearFilters = () => {
		navigate({ search: (prev) => ({ ...prev, ...CLEARED_ERROR_FILTERS }) })
	}

	const view: HubView = search.view ?? "open"
	const sort: HubSort = search.sort ?? "last_seen"
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
						<DashboardLayout.Header title="Errors">
							<ReloadControls />
						</DashboardLayout.Header>
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						<ActiveFilterChips chips={activeFilterChips} onClearAll={clearFilters} />
						<ErrorsHub
							view={view}
							sort={sort}
							severity={severity}
							range={trendWindow}
							service={search.service}
							env={search.env}
							kind={search.kind}
							regressed={search.regressed}
							onClearFilters={hasErrorFilters(search) ? clearFilters : undefined}
						/>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
