import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import { cn } from "@maple/ui/utils"
import { formatErrorRate } from "@maple/ui/lib/format"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { useAlertIncidentsList } from "@/hooks/use-alerts-list"
import {
	deriveServiceHealth,
	errorRateTone,
	incidentMatchesService,
	latencyTone,
	type LatencyBaselineSignal,
	type ServiceHealth,
} from "@/components/dashboard/service-health"
import { StatRail, StatRailItem, StatRailLoading } from "@/components/infra/primitives/stat-rail"
import { getServiceHealthBaselineResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { ServiceDetailTimeSeriesPoint } from "@/api/warehouse/services"
import type { AlertIncidentDocument } from "@maple/domain/http"
import { formatLatency } from "@/lib/format"
import { normalizeTimestampInput } from "@/lib/timezone-format"

interface ServiceHealthStripProps {
	serviceName: string
	points: ReadonlyArray<ServiceDetailTimeSeriesPoint>
	isLoading: boolean
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: string[]
}

/** Window aggregates for the KPI rail, derived from the per-bucket series. */
interface WindowAggregates {
	/** Estimated (sampling-extrapolated) requests per second over the window. */
	throughputPerSec: number
	hasSampling: boolean
	/** Traced-span-weighted error ratio (0–1). */
	errorRate: number
	/** Traced-span-weighted p95 (an approximation: mean of bucket p95s). */
	p95LatencyMs: number
	/** Traced-span-weighted Apdex. */
	apdexScore: number
	/** Traced spans in the window — the weight basis and the noise gate. */
	spanCount: number
	sparks: {
		throughput: number[]
		errorRate: number[]
		p95: number[]
		apdex: number[]
	}
}

function windowSeconds(startTime: string, endTime: string): number {
	const s = new Date(normalizeTimestampInput(startTime)).getTime()
	const e = new Date(normalizeTimestampInput(endTime)).getTime()
	return s > 0 && e > 0 ? Math.max((e - s) / 1000, 1) : 3600
}

function aggregateWindow(
	points: ReadonlyArray<ServiceDetailTimeSeriesPoint>,
	durationSeconds: number,
): WindowAggregates {
	let totalRequests = 0
	let spanCount = 0
	let errorWeighted = 0
	let p95Weighted = 0
	let apdexWeighted = 0
	let hasSampling = false
	const sparks: WindowAggregates["sparks"] = { throughput: [], errorRate: [], p95: [], apdex: [] }

	for (const point of points) {
		totalRequests += point.throughput
		spanCount += point.totalCount
		errorWeighted += point.errorRate * point.totalCount
		p95Weighted += point.p95LatencyMs * point.totalCount
		apdexWeighted += point.apdexScore * point.totalCount
		if (point.hasSampling) hasSampling = true
		sparks.throughput.push(point.throughput)
		sparks.errorRate.push(point.errorRate)
		sparks.p95.push(point.p95LatencyMs)
		sparks.apdex.push(point.apdexScore)
	}

	return {
		throughputPerSec: totalRequests / durationSeconds,
		hasSampling,
		errorRate: spanCount > 0 ? errorWeighted / spanCount : 0,
		p95LatencyMs: spanCount > 0 ? p95Weighted / spanCount : 0,
		apdexScore: spanCount > 0 ? apdexWeighted / spanCount : 0,
		spanCount,
		sparks,
	}
}

function formatRate(rate: number): string {
	if (rate >= 1000) return `${(rate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k/s`
	if (rate >= 1) return `${rate.toLocaleString(undefined, { maximumFractionDigits: 1 })}/s`
	if (rate > 0) return `${rate.toLocaleString(undefined, { maximumFractionDigits: 3 })}/s`
	return "0/s"
}

const HEALTH_LABEL: Record<ServiceHealth, string> = {
	healthy: "Healthy",
	degraded: "Degraded",
	unhealthy: "Unhealthy",
}

const HEALTH_DOT: Record<ServiceHealth, string> = {
	healthy: "bg-[var(--severity-info)]",
	degraded: "bg-[var(--severity-warn)]",
	unhealthy: "bg-[var(--severity-error)]",
}

export function ServiceHealthStrip({
	serviceName,
	points,
	isLoading,
	effectiveStartTime,
	effectiveEndTime,
	environments,
}: ServiceHealthStripProps) {
	// Trailing-7d p95 baseline so the health pill and latency tone agree with the
	// services list / dashboard badges. Deliberately not a loading gate — while
	// it's in flight (or on failure) health degrades to absolute thresholds.
	const baselineResult = useAtomValue(
		getServiceHealthBaselineResultAtom({
			data: { rangeStartTime: effectiveStartTime, environments },
		}),
	)

	// The baseline rows are keyed by (name, namespace, environment); the detail
	// page only knows the name (and maybe one environment). Pick the strongest
	// matching row — the one with the most baseline spans — so a service that
	// reports under several namespaces still gets a usable signal.
	const baseline = useMemo<LatencyBaselineSignal | undefined>(() => {
		return Result.builder(baselineResult)
			.onSuccess((response) => {
				const env = environments?.length === 1 ? environments[0] : undefined
				let best: LatencyBaselineSignal | undefined
				let bestSpans = -1
				for (const row of response.data) {
					if (row.serviceName !== serviceName) continue
					if (env !== undefined && row.environment !== env) continue
					if (row.baselineSpanCount > bestSpans) {
						bestSpans = row.baselineSpanCount
						best = { p95LatencyMs: row.baselineP95LatencyMs, spanCount: row.baselineSpanCount }
					}
				}
				return best
			})
			.orElse(() => undefined)
	}, [baselineResult, serviceName, environments])

	const { result: incidentsResult } = useAlertIncidentsList()
	const openIncidents = Result.builder(incidentsResult)
		.onSuccess((response) =>
			response.incidents.filter((incident) => incidentMatchesService(incident, serviceName)),
		)
		.orElse(() => [] as AlertIncidentDocument[])

	const aggregates = useMemo(
		() => aggregateWindow(points, windowSeconds(effectiveStartTime, effectiveEndTime)),
		[points, effectiveStartTime, effectiveEndTime],
	)

	if (isLoading) {
		return <StatRailLoading />
	}

	const health = deriveServiceHealth(
		{
			errorRate: aggregates.errorRate,
			p95LatencyMs: aggregates.p95LatencyMs,
			spanCount: aggregates.spanCount,
			baseline,
		},
		openIncidents.length > 0,
	)

	const baselineRatio =
		baseline !== undefined && baseline.p95LatencyMs > 0 && aggregates.p95LatencyMs > 0
			? aggregates.p95LatencyMs / baseline.p95LatencyMs
			: undefined

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				<span className="inline-flex items-center gap-1.5 text-xs font-medium">
					<span className={cn("size-2 rounded-full", HEALTH_DOT[health])} aria-hidden />
					{HEALTH_LABEL[health]}
				</span>
				{openIncidents.length > 0 ? (
					<Link
						to={openIncidents.length === 1 ? "/alerts/incidents/$incidentId" : "/alerts"}
						params={
							openIncidents.length === 1 ? { incidentId: openIncidents[0].id } : undefined
						}
						className="inline-flex items-center gap-1.5 rounded-md border border-[color-mix(in_oklab,var(--severity-warn)_35%,transparent)] bg-[color-mix(in_oklab,var(--severity-warn)_10%,transparent)] px-2 py-0.5 text-xs text-[var(--severity-warn)] hover:bg-[color-mix(in_oklab,var(--severity-warn)_16%,transparent)]"
					>
						{openIncidents.length === 1
							? `Open incident: ${openIncidents[0].ruleName}`
							: `${openIncidents.length} open incidents`}
						<span aria-hidden>→</span>
					</Link>
				) : null}
			</div>
			<StatRail>
				<StatRailItem
					eyebrow="Throughput"
					value={`${aggregates.hasSampling ? "~" : ""}${formatRate(aggregates.throughputPerSec)}`}
					spark={aggregates.sparks.throughput}
					subline={aggregates.hasSampling ? "Estimated from sampled traces" : undefined}
				/>
				<StatRailItem
					eyebrow="Error rate"
					value={formatErrorRate(aggregates.errorRate)}
					tone={errorRateTone(aggregates.errorRate)}
					spark={aggregates.sparks.errorRate}
				/>
				<StatRailItem
					eyebrow="p95 latency"
					value={formatLatency(aggregates.p95LatencyMs)}
					tone={latencyTone(aggregates.p95LatencyMs, aggregates.spanCount, baseline)}
					delta={
						baselineRatio !== undefined ? `${baselineRatio.toFixed(1)}× vs 7d` : undefined
					}
					spark={aggregates.sparks.p95}
				/>
				<StatRailItem
					eyebrow="Apdex"
					value={aggregates.spanCount > 0 ? aggregates.apdexScore.toFixed(2) : "—"}
					spark={aggregates.sparks.apdex}
				/>
			</StatRail>
		</div>
	)
}
