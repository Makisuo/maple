import { Link, type LinkProps } from "@tanstack/react-router"
import type { Schema } from "effect"
import type { AgentTraceListItem } from "@maple/domain/http"

import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { ArrowsSwapIcon, ChevronRightIcon } from "@/components/icons"
import { isTruncated, agentTraceIdentity, agentTraceMetaLine, agentTraceModels } from "./agent-trace-identity"
import { absoluteTimestamp, formatCost, formatAgentTraceDuration, formatTokens } from "./agent-traces-format"
import { COST_OUTLIER_DOLLARS } from "./agent-traces-filter-inputs"

/**
 * One row of the agent traces list — the wire type itself, not a restatement of it.
 * Derived from the domain schema so a field that changes shape server-side is a
 * compile error here rather than a cast that keeps compiling.
 */
export type AgentTraceRow = Schema.Schema.Type<typeof AgentTraceListItem>

/**
 * Four lanes, and no column header above them — the data has to say what it is.
 * That constraint is what fixes the widths here: identity flexes, the three
 * trailing lanes are fixed so the figures stay a column rather than a ragged
 * edge, and each one is legible on its own (`3m 12s`, `$0.412`, `2h ago`).
 *
 * There is deliberately no status lane. A column that is empty on the ~95% of
 * rows that neither failed nor are running is 26px of dead air on the leading
 * edge of every row — which is what pushed the title inboard of where the replay
 * row starts its avatar. Status moved to where replays put it: an accent stripe
 * on the edge for failures, a LIVE pill beside the title for running.
 */
const LANE = {
	/** `13.5rem` is the replay row's activity lane, to the pixel. */
	activity: "w-[13.5rem] shrink-0",
	cost: "w-20 shrink-0",
	time: "w-24 shrink-0",
} as const

/**
 * The detail link, with the partition-pruning hint the detail route documents.
 *
 * `t` is any warehouse timestamp inside the agent trace — the row's own start. Without
 * it the detail route falls back to a 7-day window ending *now*, which both scans
 * seven days of partitions on every click and misses an agent trace the list only
 * showed because the user asked for an older custom range.
 */
export const detailLinkProps = (agentTrace: Pick<AgentTraceRow, "agentTraceId" | "startTime">): LinkProps => ({
	to: "/agent-traces/$agentTraceId",
	params: { agentTraceId: agentTrace.agentTraceId },
	search: { t: agentTrace.startTime },
})

interface AgentTraceListRowProps {
	agentTrace: AgentTraceRow
	/** Suppressed when the whole view is redacted; the page banner says it once
	 *  instead of every row repeating it. */
	showRedactedInMeta: boolean
}

/**
 * The row's one rule: exactly two things are at full strength — the title, and
 * the runtime that says how long it took. Everything else is muted or a pill.
 * A list where every figure is white reads as a wall of equally-urgent numbers,
 * which is the same as no emphasis at all.
 */
export function AgentTraceListRow({ agentTrace, showRedactedInMeta }: AgentTraceListRowProps) {
	const identity = agentTraceIdentity(agentTrace)
	const models = agentTraceModels(agentTrace)
	const meta = agentTraceMetaLine(agentTrace, identity, models, { showRedacted: showRedactedInMeta })
	// The line truncates, and the `+2` in it is deliberately unreadable — the
	// tooltip is where both get spelled out.
	const metaTitle = models.overflow > 0 ? `${meta} — models: ${models.all.join(", ")}` : meta
	const truncated = isTruncated(agentTrace)
	const cost = formatCost(agentTrace.cost)
	const expensive = agentTrace.cost != null && agentTrace.cost >= COST_OUTLIER_DOLLARS

	return (
		// Geometry copied from the session replay row, not approximated: `px-3
		// py-2.5`, `gap-3` opening to `gap-4` at `@2xl`, and height left to the
		// content rather than pinned. The two lists sit in the same scroll padding,
		// so any deviation shows up as the rows disagreeing about where they start
		// and how tall they are.
		<Link
			{...detailLinkProps(agentTrace)}
			className="group relative flex items-center gap-3 border-b border-border px-3 py-2.5 transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none @2xl:gap-4"
		>
			{/* Failed agent traces get a left accent so they can be picked out while
			    scrolling, the same stripe an errored session replay carries. */}
			{agentTrace.status === "error" && (
				<span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-destructive" />
			)}

			{/* Identity lane: what it was, then who ran it. */}
			<div className="min-w-0 flex-1 overflow-hidden">
				<div className="flex min-w-0 items-center gap-2">
					<span
						className={cn(
							"min-w-0 truncate text-sm",
							identity.kind === "message"
								? "font-medium tracking-[-0.01em] text-foreground"
								: "font-mono text-foreground",
						)}
						title={identity.label}
					>
						{identity.label}
					</span>
					{agentTrace.status === "running" && <LivePill />}
					{identity.kindLabel && (
						<span className="shrink-0 font-mono text-xs text-muted-foreground">
							{identity.kindLabel}
						</span>
					)}
					{truncated && <AgentTraceBadge tone="warning">TRUNCATED</AgentTraceBadge>}
					{agentTrace.status === "error" && (
						<AgentTraceBadge tone="destructive">PROVIDER ERROR</AgentTraceBadge>
					)}
				</div>
				<div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
					<span className="truncate" title={metaTitle}>
						{meta}
					</span>
					{models.diverged && (
						<span
							className="shrink-0 text-warning"
							title={`Served model differs from the requested one (${models.requested.join(", ")})`}
						>
							<ArrowsSwapIcon className="size-3.5" />
						</span>
					)}
				</div>
			</div>

			{/* Activity lane. Same shape as the replay row's duration + pages/clicks:
			    the figure that says "how long" at full strength, what happened in
			    that time muted beside it. */}
			<div
				className={cn(
					LANE.activity,
					"hidden items-baseline gap-2 overflow-hidden whitespace-nowrap @2xl:flex",
				)}
			>
				<span className="font-mono text-[13px] font-semibold tabular-nums">
					{formatAgentTraceDuration(agentTrace.durationMs)}
				</span>
				<span className="truncate text-xs text-muted-foreground">
					{agentTrace.turnCount.toLocaleString()} turn{agentTrace.turnCount === 1 ? "" : "s"} ·{" "}
					<span title={`${agentTrace.totalTokens.toLocaleString()} tokens`}>
						{formatTokens(agentTrace.totalTokens)} tokens
					</span>
				</span>
			</div>

			{/* Cost lane. A pill, because money is the one figure on this page that
			    is compared *across* rows rather than read down one. */}
			<div className={cn(LANE.cost, "flex justify-end")}>
				{cost != null ? (
					<span
						className={cn(
							"rounded-full px-2 py-0.5 font-mono text-xs tabular-nums",
							expensive ? "bg-primary/15 font-medium text-primary" : "bg-muted text-foreground/80",
						)}
					>
						{cost}
					</span>
				) : (
					// No span carried a cost attribute. An em dash, never $0.00.
					<span
						className="font-mono text-xs text-muted-foreground/60"
						title="No cost data on this agent trace's spans"
					>
						—
					</span>
				)}
			</div>

			{/* Time lane, and the open affordance that sets the row's right margin.
			    The replay row ends the same way — time, then a glyph that only inks
			    on hover — and it is that glyph, not padding, that gives both lists
			    their breathing room on the trailing edge. */}
			<div className="flex shrink-0 items-center gap-2">
				<span
					className={cn(LANE.time, "text-right text-xs whitespace-nowrap text-muted-foreground")}
					title={absoluteTimestamp(agentTrace.startTime)}
				>
					{formatRelativeTimeOrDate(agentTrace.startTime)}
				</span>
				<span
					aria-hidden
					className="grid size-6 place-items-center rounded-full border border-border text-foreground opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100"
				>
					<ChevronRightIcon className="size-3" />
				</span>
			</div>
		</Link>
	)
}

/** Same pill an in-progress session replay carries, for the same reason: the row
 *  is still being written, and the figures beside it will move. */
function LivePill() {
	return (
		<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-1.5 py-px text-[10px] font-medium tracking-wide text-success">
			<span className="relative flex size-1.5" aria-hidden>
				<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
				<span className="relative inline-flex size-1.5 rounded-full bg-success" />
			</span>
			LIVE
		</span>
	)
}

function AgentTraceBadge({ tone, children }: { tone: "warning" | "destructive"; children: React.ReactNode }) {
	return (
		<span
			className={cn(
				"flex h-4.25 shrink-0 items-center rounded-sm px-1.5 font-mono text-xs tracking-[0.04em]",
				tone === "warning"
					? "bg-warning/15 text-warning-foreground"
					: "bg-destructive/15 text-destructive",
			)}
		>
			{children}
		</span>
	)
}
