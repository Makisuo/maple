import { useMemo } from "react"
import { cn } from "@maple/ui/utils"
import { Sparkline } from "@maple/ui/components/ui/gradient-chart"
import { Result } from "@/lib/effect-atom"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { getServiceOperationsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { formatLatency } from "@/lib/format"
import type { ServiceOperation } from "@/api/warehouse/service-operations"
import { SectionCard } from "./section-card"
import { callsPerSecond, serviceOperationsQueryInput, windowSeconds } from "./service-operations"

const PANEL_LIMIT = 5

interface ServiceTopOperationsPanelProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	environments?: string[]
	/** Switches the page to the Operations tab (URL-driven). */
	onViewAll: () => void
}

function formatRate(value: number): string {
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
	if (value >= 1) return value.toFixed(1)
	return value.toFixed(2)
}

function formatErrorRate(rate: number): string {
	if (rate >= 0.01) return `${(rate * 100).toFixed(1)}%`
	if (rate > 0) return "<1%"
	return "0%"
}

/**
 * "Top operations" digest on the Overview tab: the service's busiest span names
 * with rate/error/p95 at a glance. Reads the same atom key the Operations tab
 * fetches, so opening that tab afterwards is a cache hit. Quiet by design —
 * renders nothing while loading or when the service has no operations.
 */
export function ServiceTopOperationsPanel({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
	onViewAll,
}: ServiceTopOperationsPanelProps) {
	const result = useRetainedRefreshableResultValue(
		getServiceOperationsResultAtom({
			data: serviceOperationsQueryInput({
				serviceName,
				effectiveStartTime,
				effectiveEndTime,
				environments,
			}),
		}),
	)

	const operations = useMemo<ServiceOperation[]>(
		() =>
			Result.builder(result)
				.onSuccess((r) => r.operations.slice(0, PANEL_LIMIT))
				.orElse(() => []),
		[result],
	)

	if (operations.length === 0) return null

	const seconds = windowSeconds(effectiveStartTime, effectiveEndTime)
	const isWaiting = Result.isSuccess(result) && result.waiting
	const maxCalls = operations.reduce((acc, op) => Math.max(acc, op.estimatedSpanCount), 0)

	return (
		<SectionCard
			title="Top operations"
			className={cn("transition-opacity", isWaiting && "opacity-60")}
			action={
				<button
					type="button"
					onClick={onViewAll}
					className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					View all →
				</button>
			}
		>
			<ul className="divide-y">
				{operations.map((op) => {
					const barPct = maxCalls > 0 ? Math.min((op.estimatedSpanCount / maxCalls) * 100, 100) : 0
					return (
						<li key={op.spanName}>
							<button
								type="button"
								onClick={onViewAll}
								className="relative flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
								title={`${op.spanName} — see Operations tab`}
							>
								<div
									aria-hidden
									className="pointer-events-none absolute inset-y-1.5 left-2 rounded-sm bg-severity-info/10"
									style={{ width: `calc(${barPct}% - 0.5rem)` }}
								/>
								<span className="relative min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">
									{op.spanName}
								</span>
								<span className="relative flex shrink-0 items-center gap-3 font-mono text-[11.5px] tabular-nums">
									<span className="text-foreground">
										{op.estimatedSpanCount > op.spanCount ? "~" : ""}
										{formatRate(callsPerSecond(op.estimatedSpanCount, seconds))}/s
									</span>
									<span
										className={cn(
											op.errorRate > 0.05
												? "text-severity-error"
												: op.errorRate > 0.01
													? "text-severity-warn"
													: "text-muted-foreground/70",
										)}
									>
										{formatErrorRate(op.errorRate)}
									</span>
									<span className="text-muted-foreground/80">{formatLatency(op.p95DurationMs)}</span>
								</span>
								<Sparkline
									data={op.sparkline.map((point) => ({ value: point.count }))}
									className="relative hidden h-5 w-[88px] shrink-0 sm:block"
								/>
							</button>
						</li>
					)
				})}
			</ul>
		</SectionCard>
	)
}
