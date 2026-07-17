import { useMemo } from "react"
import { cn } from "@maple/ui/utils"
import { Result } from "@/lib/effect-atom"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { getServiceUsageResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { ServiceUsageTotals } from "@/api/warehouse/service-usage"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { SectionCard } from "./section-card"

interface ServiceUsagePanelProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
}

function formatCount(num: number): string {
	if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`
	if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
	if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`
	return num.toLocaleString()
}

function formatBytes(bytes: number): string {
	if (bytes >= 1_000_000_000_000) return `${(bytes / 1_000_000_000_000).toFixed(2)} TB`
	if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`
	if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`
	if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`
	return `${Math.round(bytes)} B`
}

/** Format a warehouse datetime back into the "YYYY-MM-DD HH:mm:ss" wire shape. */
function toWarehouseString(ms: number): string {
	return new Date(ms).toISOString().replace("T", " ").slice(0, 19)
}

/** The previous window of equal duration ending where the current one starts. */
function previousWindow(startTime: string, endTime: string) {
	const start = new Date(normalizeTimestampInput(startTime)).getTime()
	const end = new Date(normalizeTimestampInput(endTime)).getTime()
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined
	const duration = end - start
	return {
		previousStartTime: toWarehouseString(start - duration),
		previousEndTime: toWarehouseString(start),
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
		{ key: "logs", label: "Logs", format: formatCount },
		{ key: "traces", label: "Spans", format: formatCount },
		{ key: "metrics", label: "Metrics", format: formatCount },
		{ key: "dataSize", label: "Stored", format: formatBytes },
	]

	return (
		<SectionCard title="Ingest this window" className={cn("transition-opacity", isWaiting && "opacity-60")}>
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
