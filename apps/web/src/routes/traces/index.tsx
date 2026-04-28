import * as React from "react"
import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { BooleanFromStringParam, OptionalStringArrayParam } from "@/lib/search-params"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TracesTable } from "@/components/traces/traces-table"
import { TracesFilterSidebar } from "@/components/traces/traces-filter-sidebar"
import { AdvancedFilterDialog } from "@/components/traces/advanced-filter-dialog"
import { MagnifierIcon, XmarkIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useAtomValue } from "@/lib/effect-atom"
import { applyWhereClause } from "@/lib/traces/advanced-filter-sync"
import { getTracesFacetsResultAtom } from "@/lib/services/atoms/tinybird-query-atoms"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { AutocompleteValuesProvider } from "@/hooks/use-autocomplete-values"

const ContainsMatchMode = Schema.optional(Schema.Literals(["contains"]))

const AttributeFilterParam = Schema.Struct({
	key: Schema.String,
	value: Schema.String,
	matchMode: Schema.optional(Schema.Literals(["contains"])),
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
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
	rootOnly: Schema.optional(Schema.Union([Schema.Boolean, BooleanFromStringParam])),
	whereClause: Schema.optional(Schema.String),
	attributeFilters: Schema.optional(Schema.Array(AttributeFilterParam)),
	resourceAttributeFilters: Schema.optional(Schema.Array(AttributeFilterParam)),
	serviceMatchMode: ContainsMatchMode,
	spanNameMatchMode: ContainsMatchMode,
	deploymentEnvMatchMode: ContainsMatchMode,
})

export type TracesSearchParams = Schema.Schema.Type<typeof tracesSearchSchema>

export const Route = effectRoute(createFileRoute("/traces/"))({
	component: TracesPage,
	validateSearch: Schema.toStandardSchemaV1(tracesSearchSchema),
})

export function TracesPage() {
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
		<AutocompleteValuesProvider startTime={effectiveStartTime} endTime={effectiveEndTime}>
			<PageRefreshProvider timePreset={search.timePreset ?? "12h"}>
				<DashboardLayout
					breadcrumbs={[{ label: "Traces" }]}
					filterSidebar={<TracesFilterSidebar facetsResult={facetsResult} />}
					headerActions={
						<div className="flex items-center gap-2">
							<AdvancedFilterDialog
								initialValue={search.whereClause ?? ""}
								onApply={handleApplyWhereClause}
							/>
							<TimeRangeHeaderControls
								startTime={search.startTime ?? effectiveStartTime}
								endTime={search.endTime ?? effectiveEndTime}
								presetValue={search.timePreset ?? "12h"}
								onTimeChange={handleTimeChange}
							/>
						</div>
					}
				>
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
				</DashboardLayout>
			</PageRefreshProvider>
		</AutocompleteValuesProvider>
	)
}
