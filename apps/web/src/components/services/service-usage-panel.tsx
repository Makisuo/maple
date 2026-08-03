import { formatNumber, formatStorageBytes } from "@maple/ui/format"
import { useMemo } from "react"
import { cn } from "@maple/ui/utils"
import { Result } from "@/lib/effect-atom"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { getServiceUsageResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { ServiceUsageTotals } from "@/api/warehouse/service-usage"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { SectionCard } from "./section-card"

import { formatWarehouseDateTime } from "@maple/query-engine"
interface ServiceUsagePanelProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	/**
	 * True when the page has an environment filter active. This panel cannot
	 * honor it (the `service_usage` rollup is keyed org/hour/service only), so
	 * instead of silently showing blended numbers next to filtered charts it
	 * labels itself "all environments".
	 */
	envFilterActive?: boolean
}

/** The previous window of equal duration ending where the current one starts. */
function previousWindow(startTime: string, endTime: string) {
	const start = new Date(normalizeTimestampInput(startTime)).getTime()
	const end = new Date(normalizeTimestampInput(endTime)).getTime()
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined
	const duration = end - start
	return {
		previousStartTime: formatWarehouseDateTime(start - duration),
		previousEndTime: formatWarehouseDateTime(start),
	}
}

/**
 * Ingest footprint for this service over the selected window: log/trace/metric
 * item counts and stored bytes, with a delta vs the preceding window of equal
 * length. Note: the `service_usage` rollup is keyed org/hour/service only, so
 * this panel is environment-agnostic by design. Quiet — renders nothing while
 * loading, on error, or when the service reported no data.
 */
export function ServiceUsagePanel({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	envFilterActive,
}: ServiceUsagePanelProps) {
	const previous = previousWindow(effectiveStartTime, effectiveEndTime)

	const result = useRetainedRefreshableResultValue(
		getServiceUsageResultAtom({
			data: {
				service: serviceName,
				startTime: effectiveStartTime,
				endTime: effectiveEndTime,
				...previous,
			},
		}),
	)

	const view = useMemo(
		() =>
			Result.builder(result)
				.onSuccess((response) => {
					const totals = response.data.reduce<ServiceUsageTotals>(
						(acc, row) => ({
							logs: acc.logs + row.totalLogs,
							traces: acc.traces + row.totalTraces,
							metrics: acc.metrics + row.totalMetrics,
							dataSize: acc.dataSize + row.dataSizeBytes,
						}),
						{ logs: 0, traces: 0, metrics: 0, dataSize: 0 },
					)
					return { totals, previousTotals: response.previousTotals }
				})
				.orElse(() => undefined),
		[result],
	)

	if (
		!view ||
		(view.totals.logs === 0 &&
			view.totals.traces === 0 &&
			view.totals.metrics === 0 &&
			view.totals.dataSize === 0)
	) {
		return null
	}

	const isWaiting = Result.isSuccess(result) && result.waiting
	const stats: ReadonlyArray<{
		key: keyof ServiceUsageTotals
		label: string
		format: (n: number) => string
	}> = [
		{ key: "logs", label: "Logs", format: formatNumber },
		{ key: "traces", label: "Spans", format: formatNumber },
		{ key: "metrics", label: "Metrics", format: formatNumber },
		{ key: "dataSize", label: "Stored", format: formatStorageBytes },
	]

	return (
		<SectionCard
			title="Ingest this window"
			action={
				envFilterActive ? (
					<span className="text-[10px] text-muted-foreground/60">all environments</span>
				) : undefined
			}
			className={cn("transition-opacity", isWaiting && "opacity-60")}
		>
			<div className="grid grid-cols-2 gap-px sm:grid-cols-4">
				{stats.map((stat) => {
					const value = view.totals[stat.key]
					const prev = view.previousTotals?.[stat.key]
					return (
						<div key={stat.key} className="flex flex-col gap-0.5 px-4 py-3">
							<span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
								{stat.label}
							</span>
							<span className="font-mono text-lg leading-tight tabular-nums text-foreground">
								{stat.format(value)}
							</span>
							<DeltaChip current={value} previous={prev} />
						</div>
					)
				})}
			</div>
		</SectionCard>
	)
}

/** "+12%" vs the preceding window. Neutral-toned — ingest volume moving isn't
 *  inherently good or bad, so it informs without alarming. */
function DeltaChip({ current, previous }: { current: number; previous: number | undefined }) {
	if (previous === undefined || previous <= 0) {
		return <span className="text-[10px] text-muted-foreground/50">&nbsp;</span>
	}
	const change = (current - previous) / previous
	if (!Number.isFinite(change) || Math.abs(change) < 0.005) {
		return <span className="text-[10px] text-muted-foreground/50">no change</span>
	}
	return (
		<span className="text-[10px] tabular-nums text-muted-foreground">
			{change > 0 ? "+" : ""}
			{(change * 100).toFixed(0)}% vs prev
		</span>
	)
}
