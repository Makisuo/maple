import * as React from "react"
import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { warmAtoms } from "@effect-router/core"
import { Schema } from "effect"

import { BooleanFromStringParam, OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TracesTable } from "@/components/traces/traces-table"
import { TracesFilterSidebar } from "@/components/traces/traces-filter-sidebar"
import { AdvancedFilterDialog } from "@/components/traces/advanced-filter-dialog"
import { MagnifierIcon, XmarkIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { resolveEffectiveTimeRange, useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useAtomValue } from "@/lib/effect-atom"
import { applyWhereClause } from "@/lib/traces/advanced-filter-sync"
import { getTracesFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { AutocompleteValuesProvider } from "@/hooks/use-autocomplete-values"

const ContainsMatchMode = Schema.optional(Schema.Literals(["contains"]))

const TraceSortKeyParam = Schema.optional(Schema.Literals(["timestamp", "durationMs"]))
const SortDirParam = Schema.optional(Schema.Literals(["asc", "desc"]))

const AttributeFilterParam = Schema.Struct({
	key: Schema.String,
	value: Schema.String,
	matchMode: Schema.optional(Schema.Literals(["contains"])),
	negated: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
})

const tracesSearchSchema = Schema.Struct({
	services: OptionalStringArrayParam,
	spanNames: OptionalStringArrayParam,
	hasError: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	minDurationMs: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
	maxDurationMs: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
	httpMethods: OptionalStringArrayParam,
	httpStatusCodes: OptionalStringArrayParam,
	deploymentEnvs: OptionalStringArrayParam,
	namespaces: OptionalStringArrayParam,
	rootOnly: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	// Server-side drop of single-span non-entry-point traces (ui.screen
	// breadcrumbs, orphaned client spans). Defaults on; `hideNoise=false` shows
	// everything.
	hideNoise: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	minSpanCount: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
	whereClause: Schema.optional(Schema.String),
	attributeFilters: Schema.optional(Schema.Array(AttributeFilterParam)),
	resourceAttributeFilters: Schema.optional(Schema.Array(AttributeFilterParam)),
	serviceMatchMode: ContainsMatchMode,
	spanNameMatchMode: ContainsMatchMode,
	deploymentEnvMatchMode: ContainsMatchMode,
	namespaceMatchMode: ContainsMatchMode,
	excludedServices: OptionalStringArrayParam,
	excludedSpanNames: OptionalStringArrayParam,
	excludedDeploymentEnvs: OptionalStringArrayParam,
	excludedNamespaces: OptionalStringArrayParam,
	excludedHttpMethods: OptionalStringArrayParam,
	excludedHttpStatusCodes: OptionalStringArrayParam,
	// Sorting is server-side: the list is paged, so sorting the rows already
	// fetched would only reorder the current window.
	sortBy: TraceSortKeyParam,
	sortDir: SortDirParam,
	...TimeRangeSearchFields,
})

export type TracesSearchParams = Schema.Schema.Type<typeof tracesSearchSchema>

export const Route = createFileRoute("/traces/")({
	component: TracesPage,
	validateSearch: Schema.toStandardSchemaV1(tracesSearchSchema),
	loaderDeps: ({ search }) => search,
	// Only the facet sidebar is warmed. The trace list is paginated and sorted
	// from state the route does not own, so rebuilding its input here would risk
	// warming a different entry than the table reads — two fetches instead of
	// none.
	loader: ({ context, deps }) => {
		const { startTime, endTime } = resolveEffectiveTimeRange(
			deps.startTime,
			deps.endTime,
			deps.timePreset ?? "12h",
		)
		warmAtoms(context.effectRegistry, [getTracesFacetsResultAtom({ data: { startTime, endTime } })])
	},
})

function TracesPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const handleApplyWhereClause = React.useCallback(
		(newClause: string) => {
			navigate({
				search: (prev) => applyWhereClause(prev, newClause),
			})
		},
		[navigate],
	)

	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "12h",
	)

	const facetsResult = useAtomValue(
		getTracesFacetsResultAtom({
			data: {
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
			},
		}),
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
			search: (prev) => ({
				...applyTimeRangeSearch(prev, range),
			}),
		})
	}

	return (
		// lazy: the ~4 autocomplete warehouse queries (logs facets + attribute
		// keys) are only needed by the advanced-filter editor, which calls
		// activate() on focus/open — don't fire them on every page mount.
		<AutocompleteValuesProvider lazy startTime={effectiveStartTime} endTime={effectiveEndTime}>
			<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
				<DashboardLayout.Root>
					<DashboardLayout.Breadcrumbs items={[{ label: "Traces" }]} />
					<DashboardLayout.Body>
						<DashboardLayout.Filters>
							<TracesFilterSidebar facetsResult={facetsResult} />
						</DashboardLayout.Filters>
						<DashboardLayout.Content>
							<DashboardLayout.Sticky>
								<DashboardLayout.Header>
									<div className="flex flex-wrap items-center gap-2">
										<AdvancedFilterDialog
											initialValue={search.whereClause ?? ""}
											onApply={handleApplyWhereClause}
										/>
										<TimeRangeHeaderControls
											startTime={search.startTime ?? effectiveStartTime}
											endTime={search.endTime ?? effectiveEndTime}
											presetValue={
												search.timePreset ?? (search.startTime ? undefined : "12h")
											}
											onTimeChange={handleTimeChange}
										/>
									</div>
								</DashboardLayout.Header>
							</DashboardLayout.Sticky>
							<DashboardLayout.Scroll>
								{search.whereClause && (
									<div className="mb-4 flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
										<div className="flex items-center gap-2 overflow-hidden">
											<MagnifierIcon className="size-3.5 text-primary shrink-0" />
											<span
												className="text-xs font-mono text-foreground truncate"
												title={search.whereClause}
											>
												{search.whereClause}
											</span>
										</div>
										<Button
											variant="ghost"
											size="icon-xs"
											onClick={() => handleApplyWhereClause("")}
											className="shrink-0 text-muted-foreground hover:text-foreground"
											title="Clear filter"
										>
											<XmarkIcon />
											<span className="sr-only">Clear filter</span>
										</Button>
									</div>
								)}
								<TracesTable filters={search} />
							</DashboardLayout.Scroll>
						</DashboardLayout.Content>
					</DashboardLayout.Body>
				</DashboardLayout.Root>
			</PageRefreshProvider>
		</AutocompleteValuesProvider>
	)
}
