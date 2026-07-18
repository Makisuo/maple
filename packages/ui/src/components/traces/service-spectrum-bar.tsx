import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip"
import { cn } from "../../lib/utils"
import { formatDuration } from "../../lib/format"
import { getServiceColor } from "../../lib/colors"

/** The minimal span shape the share computation needs — both the web app's
 * warehouse `Span` and this package's `lib/types` `Span` satisfy it. */
export interface SpectrumSpan {
	serviceName: string
	startTime: string
	durationMs: number
}

export interface ServiceShare {
	serviceName: string
	durationMs: number
	percent: number
}

/**
 * Wall-clock time attributable to each service, as the union of that service's
 * span intervals — a parent and its child in the same service never
 * double-count. Percentages are shares of the summed union (not the trace's
 * total duration), so segments always total 100% even when services run in
 * parallel. Sorted by share, descending.
 */
export function computeServiceShares(spans: ReadonlyArray<SpectrumSpan>): Array<ServiceShare> {
	const intervalsByService = new Map<string, Array<[number, number]>>()
	for (const span of spans) {
		const start = Date.parse(span.startTime)
		if (Number.isNaN(start)) continue
		const list = intervalsByService.get(span.serviceName)
		const interval: [number, number] = [start, start + Math.max(span.durationMs, 0)]
		if (list) list.push(interval)
		else intervalsByService.set(span.serviceName, [interval])
	}

	const unions: Array<{ serviceName: string; durationMs: number }> = []
	for (const [serviceName, intervals] of intervalsByService) {
		intervals.sort((a, b) => a[0] - b[0])
		let unionMs = 0
		let [curStart, curEnd] = intervals[0]
		for (let i = 1; i < intervals.length; i++) {
			const [start, end] = intervals[i]
			if (start <= curEnd) {
				curEnd = Math.max(curEnd, end)
			} else {
				unionMs += curEnd - curStart
				curStart = start
				curEnd = end
			}
		}
		unionMs += curEnd - curStart
		unions.push({ serviceName, durationMs: unionMs })
	}

	const total = unions.reduce((sum, u) => sum + u.durationMs, 0)
	return unions
		.map((u) => ({ ...u, percent: total > 0 ? (u.durationMs / total) * 100 : 100 / unions.length }))
		.sort((a, b) => b.durationMs - a.durationMs)
}

/**
 * Segmented "where did the time go" bar: one segment per service, sized by its
 * share of union wall-clock time, colored by the service's identity color.
 * Decorative reinforcement of the legend chips beside it — each segment still
 * carries a tooltip with the exact figures.
 */
export function ServiceSpectrumBar({
	shares,
	className,
}: {
	shares: ReadonlyArray<ServiceShare>
	className?: string
}) {
	if (shares.length === 0) return null
	return (
		<TooltipProvider>
			<div className={cn("flex h-1.5 w-full gap-px overflow-hidden rounded-full", className)}>
				{shares.map((share) => (
					<Tooltip key={share.serviceName}>
						<TooltipTrigger
							render={<span />}
							className="h-full"
							style={{
								width: `${share.percent}%`,
								minWidth: "4px",
								backgroundColor: getServiceColor(share.serviceName),
							}}
						/>
						<TooltipContent side="top">
							<span className="font-mono tabular-nums">
								{share.serviceName} · {formatDuration(share.durationMs)} ·{" "}
								{share.percent.toFixed(1)}%
							</span>
						</TooltipContent>
					</Tooltip>
				))}
			</div>
		</TooltipProvider>
	)
}
