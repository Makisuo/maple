import { useNavigate, useRouterState, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MetricDetail } from "@/components/metrics/metric-detail"
import type { MetricQueryPatch } from "@/components/metrics/metric-query-controls"
import { TimeRangeSearchFields, applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import { AutocompleteValuesProvider } from "@/hooks/use-autocomplete-values"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"

const metricDetailSearchSchema = Schema.Struct({
	type: Schema.optional(Schema.Literals(QUERY_BUILDER_METRIC_TYPES)),
	agg: Schema.optional(Schema.Literals(["avg", "sum", "min", "max", "count", "rate", "increase"])),
	where: Schema.optional(Schema.String),
	groupBy: Schema.optional(Schema.String),
	step: Schema.optional(Schema.String),
	bd: Schema.optional(Schema.String),
	...TimeRangeSearchFields,
})

export type MetricDetailSearchParams = Schema.Schema.Type<typeof metricDetailSearchSchema>

/** Back to the browse page, keeping the time range but dropping detail-only params. */
function buildBackToMetricsHref(searchStr: string): string {
	const params = new URLSearchParams(searchStr)
	for (const key of ["type", "agg", "where", "groupBy", "step", "bd"]) {
		params.delete(key)
	}
	const nextSearch = params.toString()
	return nextSearch ? `/metrics?${nextSearch}` : "/metrics"
}

export const Route = createFileRoute("/metrics/$metricName")({
	component: MetricDetailPage,
	validateSearch: Schema.toStandardSchemaV1(metricDetailSearchSchema),
})

function MetricDetailPage() {
	const { metricName } = Route.useParams()
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime, endTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "24h",
	)

	const handleTimeChange = (range: { startTime?: string; endTime?: string; presetValue?: string }) => {
		navigate({ search: (prev) => applyTimeRangeSearch(prev, range) })
	}

	const handlePatch = (patch: MetricQueryPatch) => {
		navigate({
			search: (prev) => ({
				...prev,
				...("agg" in patch ? { agg: patch.agg as MetricDetailSearchParams["agg"] } : {}),
				...("where" in patch ? { where: patch.where || undefined } : {}),
				...("groupBy" in patch ? { groupBy: patch.groupBy } : {}),
				...("step" in patch ? { step: patch.step || undefined } : {}),
				...("bd" in patch ? { bd: patch.bd } : {}),
			}),
			replace: true,
		})
	}

	const searchStr = useRouterState({ select: (state) => state.location.searchStr })
	const backToMetricsHref = buildBackToMetricsHref(searchStr)

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "24h"}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[{ label: "Metrics", href: backToMetricsHref }, { label: metricName }]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								title={metricName}
								description="Explore this metric: filter, aggregate, and break it down by attributes."
							>
								<TimeRangeHeaderControls
									startTime={search.startTime}
									endTime={search.endTime}
									presetValue={search.timePreset ?? (search.startTime ? undefined : "24h")}
									defaultPreset="24h"
									onTimeChange={handleTimeChange}
								/>
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<AutocompleteValuesProvider startTime={startTime} endTime={endTime}>
								<MetricDetail
									metricName={metricName}
									state={{
										type: search.type,
										agg: search.agg,
										where: search.where,
										groupBy: search.groupBy,
										step: search.step,
										bd: search.bd,
									}}
									startTime={startTime}
									endTime={endTime}
									onPatch={handlePatch}
								/>
							</AutocompleteValuesProvider>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</PageRefreshProvider>
	)
}
