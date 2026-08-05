import { Link } from "@tanstack/react-router"

import { Button } from "@maple/ui/components/ui/button"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { agentTraceFacetsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { BarsSortIcon } from "@/components/icons"
import { XmarkIcon } from "@/components/icons"

/** One applied filter, rendered as a removable chip in the filtered-empty state. */
export interface ActiveAgentTraceFilter {
	readonly key: string
	readonly label: string
	readonly onClear: () => void
}

function EmptyFrame({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-20 text-center">
			{children}
		</div>
	)
}

/**
 * Nothing at all in the window. The exit is instrumentation or a wider range —
 * this is a "you haven't sent us any agent traces" state, not a "you filtered them
 * out" one, and the two need different exits.
 */
export function AgentTracesEmptyRange({ rangeLabel, onWiden }: { rangeLabel: string; onWiden: () => void }) {
	return (
		<EmptyFrame>
			<div className="mb-4 grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
				<BarsSortIcon className="size-6" />
			</div>
			<p className="text-sm font-medium">No agent traces in the {rangeLabel}</p>
			<p className="mt-1.5 max-w-md text-sm text-muted-foreground">
				Agent traces are reconstructed from the GenAI spans your agents already emit. Nothing to configure
				beyond pointing your SDK at Maple.
			</p>
			<div className="mt-5 flex flex-wrap items-center justify-center gap-2">
				<Button size="sm" render={<Link to="/quick-start" />}>
					Set up instrumentation
				</Button>
				<Button size="sm" variant="outline" onClick={onWiden}>
					Try the last 7 days
				</Button>
			</div>
		</EmptyFrame>
	)
}

/**
 * Filters excluded everything. The way back is the filters themselves, so they
 * are repeated here as removable chips rather than left in a sidebar the reader
 * has to go hunting through.
 *
 * The "there are N agent traces in the range" line comes from a second facets read
 * with the time range only. It runs because this component mounted — i.e. only
 * in the state that needs it — never on a page that has results.
 */
export function AgentTracesEmptyFilters({
	startTime,
	endTime,
	rangeLabel,
	filters,
	onClearAll,
}: {
	startTime: string
	endTime: string
	rangeLabel: string
	filters: ReadonlyArray<ActiveAgentTraceFilter>
	onClearAll: () => void
}) {
	const unfiltered = useAtomValue(agentTraceFacetsResultAtom({ data: { startTime, endTime } }))
	const total = Result.isSuccess(unfiltered)
		? unfiltered.value.statuses.reduce((sum, item) => sum + item.count, 0)
		: undefined

	return (
		<EmptyFrame>
			<p className="text-sm font-medium">No agent traces match these filters</p>
			<p className="mt-1.5 max-w-md text-sm text-muted-foreground">
				{total != null && total > 0
					? `There are ${total.toLocaleString()} agent traces in the ${rangeLabel}. Drop a filter to get back to them.`
					: `Drop a filter to widen the search, or change the ${rangeLabel} window.`}
			</p>
			{filters.length > 0 && (
				<div className="mt-5 flex flex-wrap items-center justify-center gap-2">
					{filters.map((filter) => (
						<button
							key={filter.key}
							type="button"
							onClick={filter.onClear}
							className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-3 font-mono text-xs text-foreground transition-colors hover:bg-muted"
							aria-label={`Remove filter ${filter.label}`}
						>
							{filter.label}
							<XmarkIcon className="size-3 text-muted-foreground" />
						</button>
					))}
					<button
						type="button"
						onClick={onClearAll}
						className="font-mono text-xs text-primary transition-colors hover:text-primary/80"
					>
						Clear all
					</button>
				</div>
			)}
		</EmptyFrame>
	)
}

/**
 * Every agent trace in view had its message content stripped. Said once, at the top,
 * instead of a "content redacted" marker repeated down every row — a column of
 * identical placeholders is exactly what makes a redacted list unreadable.
 */
export function AgentTracePrivacyBanner() {
	return (
		<div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-border bg-muted/40 px-3 py-2">
			<span className="font-mono text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
				Privacy mode
			</span>
			<p className="min-w-0 flex-1 font-mono text-xs text-muted-foreground">
				No agent trace in this view records message text, so they are named by workflow, then agent,
				then id. Timing, tokens, models and cost are complete.
			</p>
		</div>
	)
}
