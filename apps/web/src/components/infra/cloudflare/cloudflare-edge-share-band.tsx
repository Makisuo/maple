import { useMemo } from "react"

import { cn } from "@maple/ui/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

import type { CloudflareZoneCacheBucket } from "@/api/warehouse/cloudflare-infra"
import { formatNumber } from "@/lib/format"
import { formatPercent } from "../format"
import { EDGE_SERVED_STATUSES } from "./constants"

/**
 * The zone's job, in one bar: how much traffic the edge answered without
 * touching origin. Cache-served statuses render as primary-hued segments
 * (strongest = plain hit), everything else pools into a muted "origin"
 * remainder. Proportions are the window totals from the cache breakdown.
 */

const ORIGIN_COLOR = "color-mix(in oklab, var(--muted-foreground) 28%, transparent)"

interface CloudflareEdgeShareBandProps {
	cacheBuckets: ReadonlyArray<CloudflareZoneCacheBucket>
	className?: string
}

export function CloudflareEdgeShareBand({ cacheBuckets, className }: CloudflareEdgeShareBandProps) {
	const { segments, originShare, originRequests, edgeShare, total } = useMemo(() => {
		const totals = new Map<string, number>()
		let sum = 0
		for (const row of cacheBuckets) {
			totals.set(row.cacheStatus, (totals.get(row.cacheStatus) ?? 0) + row.requests)
			sum += row.requests
		}
		const edge = EDGE_SERVED_STATUSES.map((seg) => ({
			...seg,
			requests: totals.get(seg.status) ?? 0,
			share: sum > 0 ? (totals.get(seg.status) ?? 0) / sum : 0,
		})).filter((seg) => seg.requests > 0)
		const edgeTotal = edge.reduce((acc, seg) => acc + seg.requests, 0)
		return {
			segments: edge,
			total: sum,
			edgeShare: sum > 0 ? edgeTotal / sum : 0,
			originRequests: sum - edgeTotal,
			originShare: sum > 0 ? (sum - edgeTotal) / sum : 0,
		}
	}, [cacheBuckets])

	if (total === 0) return null

	return (
		<div className={cn("rounded-md border bg-card px-5 py-4", className)}>
			<div className="flex items-baseline justify-between gap-3">
				<div className="flex items-baseline gap-2">
					<span className="font-mono text-[22px] font-semibold tabular-nums leading-none text-foreground">
						{formatPercent(edgeShare)}
					</span>
					<span className="text-[11px] font-medium text-muted-foreground">served at the edge</span>
				</div>
				<div className="flex items-baseline gap-2">
					<span className="text-[11px] font-medium text-muted-foreground">from origin</span>
					<span className="font-mono text-[13px] font-medium tabular-nums text-foreground/80">
						{formatPercent(originShare)}
					</span>
				</div>
			</div>
			<div className="mt-3 flex h-3 w-full overflow-hidden rounded-sm">
				{segments.map((seg) => (
					<Tooltip key={seg.status}>
						<TooltipTrigger
							render={<div />}
							tabIndex={0}
							className="h-full min-w-[2px]"
							style={{ width: `${seg.share * 100}%`, background: seg.color }}
							aria-label={`${seg.label}: ${formatPercent(seg.share)}`}
						/>
						<TooltipContent>
							{seg.label} · {formatNumber(seg.requests)} requests ({formatPercent(seg.share)})
						</TooltipContent>
					</Tooltip>
				))}
				<Tooltip>
					<TooltipTrigger
						render={<div />}
						tabIndex={0}
						className="h-full flex-1"
						style={{ background: ORIGIN_COLOR }}
						aria-label={`Origin: ${formatPercent(originShare)}`}
					/>
					<TooltipContent>
						Origin · {formatNumber(originRequests)} requests ({formatPercent(originShare)})
					</TooltipContent>
				</Tooltip>
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
				{segments.map((seg) => (
					<span key={seg.status} className="inline-flex items-baseline gap-1.5">
						<span
							aria-hidden
							className="size-2 translate-y-[-1px] rounded-[2px]"
							style={{ background: seg.color }}
						/>
						<span className="text-[11px] text-muted-foreground">{seg.label}</span>
						<span className="font-mono text-[11px] tabular-nums text-foreground/75">
							{formatNumber(seg.requests)}
						</span>
					</span>
				))}
				<span className="inline-flex items-baseline gap-1.5">
					<span
						aria-hidden
						className="size-2 translate-y-[-1px] rounded-[2px]"
						style={{ background: ORIGIN_COLOR }}
					/>
					<span className="text-[11px] text-muted-foreground">Origin</span>
					<span className="font-mono text-[11px] tabular-nums text-foreground/75">
						{formatNumber(originRequests)}
					</span>
				</span>
			</div>
		</div>
	)
}
