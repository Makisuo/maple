import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { Result } from "@/lib/effect-atom"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { getErrorsSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { GetErrorsSummaryInput } from "@/api/warehouse/errors"

/**
 * Window totals for the current filters.
 *
 * This replaced four KPI cards. The numbers are worth keeping — "how much is
 * broken right now" and "is that a lot" are real questions — but as a card row
 * they took the top third of the page to say what fits on one line, and pushed
 * the list (the thing you came for) below the fold.
 *
 * Reads as a sentence, not a dashboard: the value carries the weight, the label
 * stays quiet, and it sits inline with the toolbar.
 */
export function ErrorsStatStrip({ filters }: { filters: GetErrorsSummaryInput }) {
	const summaryResult = useRefreshableAtomValue(getErrorsSummaryResultAtom({ data: filters }))

	return (
		Result.builder(summaryResult)
			.onInitial(() => (
				<div className="flex items-center gap-4 px-3 py-2">
					<Skeleton className="h-4 w-24" />
					<Skeleton className="h-4 w-28" />
					<Skeleton className="h-4 w-24" />
				</div>
			))
			// A failed summary must not take the list down with it — the rows carry
			// their own counts and are the page's actual job.
			.onError(() => null)
			.onSuccess((response, result) => {
				const summary = response.data
				if (!summary) return null

				const stats = [
					{ value: formatNumber(summary.totalErrors), label: "errors" },
					{ value: formatErrorRate(summary.errorRate), label: "of all spans" },
					{ value: formatNumber(summary.affectedServicesCount), label: "services" },
					{ value: formatNumber(summary.affectedTracesCount), label: "traces" },
				]

				return (
					<div
						className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs ${
							result.waiting ? "opacity-60" : ""
						}`}
					>
						{stats.map((stat) => (
							<span key={stat.label} className="flex items-baseline gap-1.5">
								<span className="font-medium tabular-nums text-foreground">{stat.value}</span>
								<span className="text-muted-foreground">{stat.label}</span>
							</span>
						))}
						<span className="text-muted-foreground/60">in the selected window</span>
					</div>
				)
			})
			.render()
	)
}
