import type { CycleCostEstimate } from "@/lib/billing/cost-estimate"

import { formatCurrency } from "@/lib/billing/currency"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

export function CostBreakdownSkeleton() {
	return (
		<div className="divide-y divide-border/60">
			{Array.from({ length: 3 }).map((_, i) => (
				<div key={i} className="flex items-center justify-between py-2.5">
					<div className="flex flex-col gap-1.5">
						<Skeleton className="h-3.5 w-28" />
						<Skeleton className="h-3 w-44" />
					</div>
					<Skeleton className="h-3.5 w-14" />
				</div>
			))}
		</div>
	)
}

/**
 * Line-item breakdown of the current cycle's estimated cost: base plan price(s)
 * plus per-feature overage, ending in an estimated total. Purely presentational
 * — the math lives in lib/billing/cost-estimate.ts.
 */
export function CostBreakdown({ estimate }: { estimate: CycleCostEstimate }) {
	return (
		<div>
			<div className="divide-y divide-border/60">
				{estimate.lines.map((line) => (
					<div key={line.key} className="flex items-baseline justify-between gap-4 py-2.5">
						<div className="min-w-0">
							<p className="text-sm">{line.label}</p>
							{line.detail && (
								<p className="text-muted-foreground/70 mt-0.5 text-[11px] tabular-nums">
									{line.detail}
								</p>
							)}
						</div>
						<span className="text-sm tabular-nums">
							{formatCurrency(line.amount, estimate.currency)}
						</span>
					</div>
				))}
				<div className="flex items-baseline justify-between gap-4 py-2.5">
					<p className="text-sm font-medium">Estimated total</p>
					<span className="text-sm font-semibold tabular-nums">
						{estimate.partial && <span className="text-muted-foreground font-normal">at least </span>}
						{formatCurrency(estimate.total, estimate.currency)}
					</span>
				</div>
			</div>
			<p className="text-muted-foreground/70 mt-2 text-[11px]">
				So far this cycle · excludes taxes &amp; credits
				{estimate.partial &&
					" · some items are on legacy pricing we can't itemize — see your invoice for the exact amount"}
			</p>
		</div>
	)
}
