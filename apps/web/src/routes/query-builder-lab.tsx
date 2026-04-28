import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { QueryBuilderLab } from "@/components/query-builder/query-builder-lab"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const queryBuilderLabSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/query-builder-lab"))({
	component: QueryBuilderLabPage,
	validateSearch: Schema.toStandardSchemaV1(queryBuilderLabSearchSchema),
})

function QueryBuilderLabPage() {
	const search = Route.useSearch()
	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "1h"}>
			<QueryBuilderLabContent />
		</PageRefreshProvider>
	)
}

function QueryBuilderLabContent() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const { startTime: effectiveStartTime, endTime: effectiveEndTime } = useEffectiveTimeRange(
		search.startTime,
		search.endTime,
		search.timePreset ?? "1h",
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
			search: (previous: Record<string, unknown>) => ({
				...applyTimeRangeSearch(previous, range),
			}),
		})
	}

	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Overview", href: "/" }, { label: "Query Builder Lab" }]}
			title="Query Builder Lab"
			description="MVP Query builder"
			headerActions={
				<TimeRangeHeaderControls
					startTime={search.startTime}
					endTime={search.endTime}
					presetValue={search.timePreset ?? "1h"}
					onTimeChange={handleTimeChange}
				/>
			}
		>
			<QueryBuilderLab startTime={effectiveStartTime} endTime={effectiveEndTime} />
		</DashboardLayout>
	)
}
