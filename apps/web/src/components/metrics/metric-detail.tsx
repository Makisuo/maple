import * as React from "react"
import { Suspense } from "react"

import { Result } from "@/lib/effect-atom"
import { getChartById } from "@maple/ui/components/charts/registry"
import { ChartSkeleton } from "@maple/ui/components/charts/_shared/chart-skeleton"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { QueryErrorState } from "@/components/common/query-error-state"
import { MetricQueryControls, type MetricQueryPatch } from "./metric-query-controls"
import { MetricBreakdown, appendWhereFilter } from "./metric-breakdown"
import { MetricGraduationActions } from "./metric-graduation-actions"
import { MetricMetadataPanel } from "./metric-metadata-panel"
import {
	getQueryBuilderTimeseriesResultAtom,
	listMetricsResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import type { Metric } from "@/api/warehouse/metrics"
import {
	resetAggregationForMetricType,
	type MetricsQueryDraft,
	type QueryBuilderMetricType,
} from "@/lib/query-builder/model"

export interface MetricDetailQueryState {
	type?: QueryBuilderMetricType
	agg?: string
	where?: string
	groupBy?: string
	step?: string
	bd?: string
}

/**
 * The union of the catalog rows for one metric name: the catalog stores one
 * row per (metric, service), so a metric emitted by three services has three
 * rows that need merging for the header/metadata.
 */
export interface MetricCatalogSummary {
	metricName: string
	metricType: QueryBuilderMetricType
	services: string[]
	description: string
	unit: string
	dataPointCount: number
	firstSeen: string
	lastSeen: string
	isMonotonic: boolean
}

const METRIC_TYPES: ReadonlySet<string> = new Set(["sum", "gauge", "histogram", "exponential_histogram"])

export function summarizeCatalogRows(
	rows: Metric[],
	metricName: string,
	metricType?: QueryBuilderMetricType,
): MetricCatalogSummary | null {
	const matches = rows.filter(
		(row) =>
			row.metricName === metricName &&
			METRIC_TYPES.has(row.metricType) &&
			(!metricType || row.metricType === metricType),
	)
	const first = matches[0]
	if (!first) return null

	return {
		metricName,
		metricType: first.metricType as QueryBuilderMetricType,
		services: [...new Set(matches.map((row) => row.serviceName).filter(Boolean))],
		description: matches.map((row) => row.metricDescription).find((d) => d.length > 0) ?? "",
		unit: matches.map((row) => row.metricUnit).find((u) => u.length > 0) ?? "",
		dataPointCount: matches.reduce((total, row) => total + row.dataPointCount, 0),
		firstSeen: matches.reduce((min, row) => (row.firstSeen < min ? row.firstSeen : min), first.firstSeen),
		lastSeen: matches.reduce((max, row) => (row.lastSeen > max ? row.lastSeen : max), first.lastSeen),
		isMonotonic: matches.some((row) => row.isMonotonic),
	}
}

export function defaultAggregation(metricType: QueryBuilderMetricType, isMonotonic: boolean): string {
	return resetAggregationForMetricType(metricType === "sum" ? "rate" : "avg", metricType, isMonotonic)
}

/** Maps OTel unit strings onto the chart formatter's unit vocabulary. */
function chartUnitFromOtel(unit: string): string | undefined {
	switch (unit) {
		case "ns":
			return "duration_ns"
		case "us":
			return "duration_us"
		case "ms":
			return "duration_ms"
		case "s":
			return "duration_s"
		case "By":
		case "by":
		case "bytes":
			return "bytes"
		default:
			return undefined
	}
}

export function buildMetricExplorerDraft(
	summary: MetricCatalogSummary,
	state: MetricDetailQueryState,
): MetricsQueryDraft {
	const aggregation = resetAggregationForMetricType(
		state.agg ?? defaultAggregation(summary.metricType, summary.isMonotonic),
		summary.metricType,
		summary.isMonotonic,
	)

	return {
		// Stable id: the draft is an atom-family key, and it round-trips into
		// dashboard widgets / alert prefills where a fresh uuid is minted.
		id: "metrics-explorer-a",
		name: "A",
		enabled: true,
		hidden: false,
		dataSource: "metrics",
		signalSource: "default",
		metricName: summary.metricName,
		metricType: summary.metricType,
		isMonotonic: summary.isMonotonic,
		whereClause: state.where ?? "",
		aggregation,
		stepInterval: state.step ?? "",
		orderByDirection: "desc",
		addOns: {
			groupBy: Boolean(state.groupBy),
			having: false,
			orderBy: false,
			limit: false,
			legend: false,
		},
		groupBy: state.groupBy ? [state.groupBy] : [],
		having: "",
		orderBy: "",
		limit: "",
		legend: "",
	}
}

interface MetricDetailProps {
	metricName: string
	state: MetricDetailQueryState
	startTime: string
	endTime: string
	onPatch: (patch: MetricQueryPatch) => void
}

export function MetricDetail({ metricName, state, startTime, endTime, onPatch }: MetricDetailProps) {
	const catalogResult = useRefreshableAtomValue(
		listMetricsResultAtom({
			data: { search: metricName, startTime, endTime, limit: 1000 },
		}),
	)

	return Result.builder(catalogResult)
		.onInitial(() => (
			<div className="space-y-4">
				<Skeleton className="h-14 w-full" />
				<Skeleton className="h-80 w-full" />
			</div>
		))
		.onError((error) => <QueryErrorState error={error} titleOverride="Failed to load metric" />)
		.onSuccess((response) => {
			const summary = summarizeCatalogRows(response.data, metricName, state.type)
			if (!summary) {
				return (
					<div className="flex flex-col items-center justify-center rounded-md border border-dashed p-12 text-center">
						<p className="text-sm font-medium">No data for this metric in the selected range</p>
						<p className="mt-2 max-w-md text-sm text-muted-foreground">
							<span className="font-mono">{metricName}</span> has no datapoints between{" "}
							{startTime} and {endTime}. Widen the time range, or check that the service
							emitting it is still running.
						</p>
					</div>
				)
			}
			return (
				<MetricDetailContent
					summary={summary}
					state={state}
					startTime={startTime}
					endTime={endTime}
					onPatch={onPatch}
				/>
			)
		})
		.render()
}

function MetricDetailContent({
	summary,
	state,
	startTime,
	endTime,
	onPatch,
}: {
	summary: MetricCatalogSummary
	state: MetricDetailQueryState
	startTime: string
	endTime: string
	onPatch: (patch: MetricQueryPatch) => void
}) {
	const draft = React.useMemo(() => buildMetricExplorerDraft(summary, state), [summary, state])

	return (
		<div className="flex flex-col gap-4">
			<div className="flex justify-end">
				<MetricGraduationActions draft={draft} />
			</div>
			<MetricQueryControls
				metricName={summary.metricName}
				metricType={summary.metricType}
				isMonotonic={summary.isMonotonic}
				aggregation={draft.aggregation}
				whereClause={state.where ?? ""}
				groupBy={state.groupBy}
				stepInterval={state.step ?? ""}
				startTime={startTime}
				endTime={endTime}
				onPatch={onPatch}
			/>

			<div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
				<div className="flex min-w-0 flex-col gap-4">
					<MetricChart
						draft={draft}
						unit={summary.unit}
						startTime={startTime}
						endTime={endTime}
					/>
					<MetricBreakdown
						draft={draft}
						breakdownKey={state.bd}
						startTime={startTime}
						endTime={endTime}
						onBreakdownKeyChange={(key) => onPatch({ bd: key })}
						onAddFilter={(key, value) =>
							onPatch({ where: appendWhereFilter(state.where ?? "", key, value) })
						}
					/>
				</div>
				<MetricMetadataPanel summary={summary} startTime={startTime} endTime={endTime} />
			</div>
		</div>
	)
}

function MetricChart({
	draft,
	unit,
	startTime,
	endTime,
}: {
	draft: MetricsQueryDraft
	unit: string
	startTime: string
	endTime: string
}) {
	const result = useRefreshableAtomValue(
		getQueryBuilderTimeseriesResultAtom({
			data: { startTime, endTime, queries: [draft] },
		}),
	)

	const entry = getChartById("query-builder-area")
	if (!entry) return null
	const ChartComponent = entry.component

	const queryLabel = `${draft.aggregation}(${draft.metricName})${
		draft.groupBy[0] ? ` by ${draft.groupBy[0]}` : ""
	}`

	return (
		<div className="rounded-md border bg-card">
			<div className="flex items-center justify-between gap-2 border-b px-3 py-2">
				<span className="truncate font-mono text-xs text-muted-foreground">{queryLabel}</span>
				{unit && <span className="shrink-0 text-xs text-muted-foreground">unit: {unit}</span>}
			</div>
			<div className="h-80 p-3">
				{Result.builder(result)
					.onInitial(() => <ChartSkeleton variant="area" />)
					.onError((error) => (
						<QueryErrorState error={error} titleOverride="Failed to load metric data" />
					))
					.onSuccess((response) =>
						response.data.length === 0 ? (
							<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
								No datapoints match this query in the selected range.
							</div>
						) : (
							<Suspense fallback={<ChartSkeleton variant="area" />}>
								<ChartComponent
									data={response.data}
									className="h-full w-full aspect-auto"
									legend={draft.groupBy.length > 0 ? "visible" : "hidden"}
									seriesStats={false}
									unit={chartUnitFromOtel(unit)}
								/>
							</Suspense>
						),
					)
					.render()}
			</div>
		</div>
	)
}
