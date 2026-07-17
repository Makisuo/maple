import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MetricsBrowse, type MetricsBrowsePatch } from "@/components/metrics/metrics-browse"
import { applyTimeRangeSearch } from "@/components/time-range-picker/search"
import { PageRefreshProvider } from "@/components/time-range-picker/page-refresh-context"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"

const METRIC_TYPE_VALUES = ["sum", "gauge", "histogram", "exponential_histogram"] as const

function asMetricType(value: string): (typeof METRIC_TYPE_VALUES)[number] | undefined {
	return METRIC_TYPE_VALUES.find((type) => type === value)
}

const metricsSearchSchema = Schema.Struct({
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
	q: Schema.optional(Schema.String),
	type: Schema.optional(Schema.Literals(["sum", "gauge", "histogram", "exponential_histogram"])),
	view: Schema.optional(Schema.Literals(["grid", "table"])),
})

export type MetricsSearchParams = Schema.Schema.Type<typeof metricsSearchSchema>

export const Route = createFileRoute("/metrics/")({
	component: MetricsPage,
	validateSearch: Schema.toStandardSchemaV1(metricsSearchSchema),
})

function MetricsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })

	const handleTimeChange = (range: { startTime?: string; endTime?: string; presetValue?: string }) => {
		navigate({ search: (prev) => applyTimeRangeSearch(prev, range) })
	}

	const handlePatch = (patch: MetricsBrowsePatch) => {
		navigate({
			search: (prev) => ({
				...prev,
				...("q" in patch ? { q: patch.q || undefined } : {}),
				...("type" in patch ? { type: patch.type } : {}),
				...("view" in patch ? { view: patch.view === "grid" ? undefined : patch.view } : {}),
			}),
			replace: true,
		})
	}

	return (
		<PageRefreshProvider timePreset={search.timePreset ?? "24h"}>
			<DashboardLayout
				breadcrumbs={[{ label: "Metrics" }]}
				title="Metrics"
				description="Explore and analyze OpenTelemetry metrics from your services."
				headerActions={
					<TimeRangeHeaderControls
						startTime={search.startTime}
						endTime={search.endTime}
						presetValue={search.timePreset ?? (search.startTime ? undefined : "24h")}
						defaultPreset="24h"
						onTimeChange={handleTimeChange}
					/>
				}
			>
				<MetricsBrowse
					startTime={search.startTime}
					endTime={search.endTime}
					timePreset={search.timePreset}
					q={search.q ?? ""}
					type={search.type ?? null}
					view={search.view ?? "grid"}
					onPatch={handlePatch}
					onOpenMetric={(metric) => {
						navigate({
							to: "/metrics/$metricName",
							params: { metricName: metric.metricName },
							search: {
								startTime: search.startTime,
								endTime: search.endTime,
								timePreset: search.timePreset,
								type: asMetricType(metric.metricType),
							},
						})
					}}
				/>
			</DashboardLayout>
		</PageRefreshProvider>
	)
}
