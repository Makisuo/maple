import { useMemo, useState, type ReactNode } from "react"

import { ArrowRightIcon, ChevronRightIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { cn } from "@maple/ui/lib/utils"

import {
	buildSessionFindings,
	turnOrdinal,
	type FindingSeverity,
	type SessionFinding,
	type SessionVerdict,
	type TurnHealth,
} from "@/lib/agent-sessions/session-findings"
import {
	formatCost,
	type IdleGap,
	type SessionSummary,
	type SessionToolUsage,
} from "@/lib/agent-sessions/session-summary"
import type { SessionTurn } from "@/lib/agent-sessions/session-turns"
import type { SessionToolResults } from "@/lib/agent-sessions/span-detail"
import { shortTarget } from "@/lib/agent-sessions/span-filters"
import type { SpanDetailTab } from "./span-expansion"
import { SpanPopover } from "./span-popover"
import { OCCUPANCY_DOT_FILL, OCCUPANCY_FILL, OCCUPANCY_LABEL } from "./span-visuals"

const TOKEN_BUCKETS = [
	{ key: "input", label: "Input", fill: "bg-chart-2" },
	{ key: "cacheRead", label: "Cache read", fill: "bg-chart-4" },
	{ key: "cacheWrite", label: "Cache write", fill: "bg-chart-5" },
	{ key: "output", label: "Output", fill: "bg-chart-1" },
	{ key: "reasoning", label: "Reasoning", fill: "bg-chart-3" },
] as const

const SEVERITY_DOT = {
	failure: "bg-destructive",
	anomaly: "bg-severity-warn",
} satisfies Record<FindingSeverity, string>

/**
 * The triage view: did the session work, and if not, what exactly went wrong.
 *
 * The page leads with a verdict and a findings list rather than another way to
 * browse the turns — Traces, Flow and Transcript already do that three ways.
 * Every finding opens the span that is its evidence in place, against the row
 * that named it: reading a finding used to cost the reader this page. The facts
 * — time bar, cost, tokens, tools — stay, each figure appearing exactly once.
 */
export function SessionOverview({
	turns,
	summary,
	selectedSpanId,
	onSelectSpan,
	spanTab,
	onSpanTabChange,
	toolResults,
	onOpenTraceView,
}: {
	turns: readonly SessionTurn[]
	summary: SessionSummary
	/** The one span open in the popover (`?span=`). */
	selectedSpanId: string | undefined
	/** Raised with a span id to open it, `undefined` to close. */
	onSelectSpan: (spanId: string | undefined) => void
	/** The popover's tab, shared with the other views. */
	spanTab: SpanDetailTab | undefined
	onSpanTabChange: (tab: SpanDetailTab) => void
	/** The session's captured tool results by call id, for the popover. */
	toolResults?: SessionToolResults
	/** The popover's "Open in Traces view": same span, sibling view. */
	onOpenTraceView: () => void
}) {
	const report = useMemo(() => buildSessionFindings(turns, summary), [turns, summary])
	const spansById = useMemo(
		() => new Map(turns.flatMap((turn) => turn.spans).map((span) => [span.spanId, span])),
		[turns],
	)

	// A finding carries a span id; the row that named it is what the popover
	// points at. Kept together so a selection made elsewhere — a pasted `?span=`,
	// or the reader coming back from another view — cannot anchor the panel to
	// the row of a different span.
	const [anchor, setAnchor] = useState<{ spanId: string; element: HTMLElement } | undefined>(undefined)
	const anchored = anchor !== undefined && anchor.spanId === selectedSpanId

	const openSpan = (spanId: string, element: HTMLElement) => {
		setAnchor({ spanId, element })
		onSelectSpan(selectedSpanId === spanId ? undefined : spanId)
	}

	return (
		<div className="@container flex grow flex-col pt-5 pb-10">
			<div className="flex flex-col gap-8 @4xl:flex-row @4xl:gap-8">
				<div className="flex min-w-0 grow flex-col gap-7">
					<Verdict
						verdict={report.verdict}
						findingCount={report.findings.length}
						turns={turns}
						onOpenSpan={openSpan}
					/>
					<Findings findings={report.findings} onOpenSpan={openSpan} />
					<TurnHealthStrip
						turns={turns}
						health={report.turnHealth}
						summary={summary}
						onOpenSpan={openSpan}
					/>
					<TimeComposition summary={summary} turns={turns} />
				</div>
				<Rail summary={summary} />
			</div>

			<SpanPopover
				span={anchored && selectedSpanId !== undefined ? spansById.get(selectedSpanId) : undefined}
				anchor={anchored ? anchor.element : null}
				tab={spanTab}
				onTabChange={onSpanTabChange}
				toolResults={toolResults}
				onClose={() => onSelectSpan(undefined)}
				onOpenTraceView={onOpenTraceView}
			/>
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Verdict                                                                    */
/* -------------------------------------------------------------------------- */

/** Open a span's payload against the element that named it. */
type OpenSpan = (spanId: string, anchor: HTMLElement) => void

function Verdict({
	verdict,
	findingCount,
	turns,
	onOpenSpan,
}: {
	verdict: SessionVerdict
	findingCount: number
	turns: readonly SessionTurn[]
	onOpenSpan: OpenSpan
}) {
	const turnWord = turns[0]?.anchorKind === "trace" ? "segment" : "turn"
	const turnsText = `${turns.length} ${turnWord}${turns.length === 1 ? "" : "s"}`

	return (
		<section className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
			<div className="flex min-w-0 flex-col gap-1.5">
				{verdict.status === "failed" ? (
					<>
						<p className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-semibold text-lg">
							<VerdictDot className="bg-destructive" />
							<span className="text-destructive">Failed</span>
							{verdict.label !== undefined && (
								<>
									<span aria-hidden className="text-muted-foreground">
										—
									</span>
									<span className="min-w-0 truncate font-mono text-[0.95em]">{verdict.label}</span>
									<span>on the final {turnWord}</span>
								</>
							)}
						</p>
						<p className="pl-[1.375rem] text-muted-foreground text-sm">
							The final {turnWord} did not close cleanly.
						</p>
					</>
				) : verdict.status === "attention" ? (
					// No subline: the findings right below are the explanation, and a
					// sentence pointing at them said nothing the layout doesn't.
					<p className="flex items-baseline gap-x-2 font-semibold text-lg">
						<VerdictDot className="bg-severity-warn" />
						<span>
							Completed, with {findingCount} {findingCount === 1 ? "finding" : "findings"}
						</span>
					</p>
				) : (
					<>
						<p className="flex items-baseline gap-x-2 font-semibold text-lg">
							<VerdictDot className="bg-severity-info" />
							<span className="text-severity-info">Completed cleanly</span>
						</p>
						<p className="pl-[1.375rem] text-muted-foreground text-sm">
							No errors, refusals, truncated replies, stalls, or repetition across {turnsText}.
						</p>
					</>
				)}
			</div>
			{verdict.spanId !== undefined && (
				<Button
					variant="outline"
					size="sm"
					aria-haspopup="dialog"
					onClick={(event) => onOpenSpan(verdict.spanId!, event.currentTarget)}
				>
					Open failing span
					<ArrowRightIcon size={14} />
				</Button>
			)}
		</section>
	)
}

function VerdictDot({ className }: { className: string }) {
	return <span aria-hidden className={cn("size-2.5 shrink-0 self-center rounded-full", className)} />
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

function Findings({ findings, onOpenSpan }: { findings: readonly SessionFinding[]; onOpenSpan: OpenSpan }) {
	return (
		<section>
			<div className="flex items-baseline justify-between gap-2 pb-3.5">
				<h3 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.09em]">
					Findings
				</h3>
				{findings.length > 0 && (
					<span
						className={cn(
							"font-mono text-xs tabular-nums",
							findings.some((finding) => finding.severity === "failure")
								? "text-destructive"
								: "text-severity-warn",
						)}
					>
						{findings.length}
					</span>
				)}
			</div>

			{findings.length === 0 ? (
				<p className="border-border border-t py-6 text-muted-foreground text-sm">No findings.</p>
			) : (
				findings.map((finding) => (
					<FindingRow key={finding.id} finding={finding} onOpenSpan={onOpenSpan} />
				))
			)}
		</section>
	)
}

function FindingRow({ finding, onOpenSpan }: { finding: SessionFinding; onOpenSpan: OpenSpan }) {
	return (
		<button
			type="button"
			aria-haspopup="dialog"
			onClick={(event) => onOpenSpan(finding.spanId, event.currentTarget)}
			className={cn(
				"group flex w-full items-start gap-3 border-border border-t px-3 py-3.5 text-left hover:bg-accent/40",
				finding.severity === "failure" &&
					"border-l-2 border-l-destructive bg-destructive/[0.06] pl-2.5",
			)}
		>
			<span
				aria-hidden
				className={cn("mt-[0.4rem] size-1.5 shrink-0 rounded-full", SEVERITY_DOT[finding.severity])}
			/>
			<span className="flex min-w-0 grow flex-col gap-1">
				<span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
					<span
						className={cn(
							"min-w-0 truncate font-medium font-mono text-[13px]",
							finding.severity === "failure" && "text-destructive",
						)}
					>
						{finding.label}
						{finding.count > 1 && ` ×${finding.count}`}
					</span>
					<span className="shrink-0 text-muted-foreground text-xs">{finding.turnText}</span>
				</span>
				{finding.detail !== undefined && (
					<span className="text-muted-foreground text-xs leading-relaxed">{finding.detail}</span>
				)}
			</span>
			<span className="mt-0.5 flex shrink-0 items-center gap-1 text-muted-foreground text-xs opacity-0 transition-opacity group-hover:opacity-100">
				inspect
				<ArrowRightIcon size={12} />
			</span>
		</button>
	)
}

/* -------------------------------------------------------------------------- */
/* Session shape                                                              */
/* -------------------------------------------------------------------------- */

const HEALTH_CELL = {
	clean: "border-border bg-muted/40 text-muted-foreground hover:bg-accent",
	anomaly: "border-severity-warn/40 bg-severity-warn/10 text-severity-warn hover:bg-severity-warn/20",
	failure: "border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20",
} satisfies Record<TurnHealth, string>

function TurnHealthStrip({
	turns,
	health,
	summary,
	onOpenSpan,
}: {
	turns: readonly SessionTurn[]
	health: readonly TurnHealth[]
	summary: SessionSummary
	onOpenSpan: OpenSpan
}) {
	// "with errors", not "failed": a red cell marks a turn something went wrong
	// INSIDE — the turn itself may have closed cleanly, and calling it failed
	// would contradict a Completed verdict two sections up.
	const errored = health.filter((status) => status === "failure").length
	const flagged = health.filter((status) => status === "anomaly").length
	const caption = [
		errored > 0 ? `${errored} with errors` : undefined,
		flagged > 0 ? `${flagged} flagged` : undefined,
		errored === 0 && flagged === 0 ? "none flagged" : undefined,
		`${formatSessionDuration(summary.wallClockMs)} wall clock`,
	]
		.filter((part) => part !== undefined)
		.join(" · ")

	return (
		<section>
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-3.5">
				<h3 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.09em]">
					Session shape
				</h3>
				<span className="font-mono text-muted-foreground text-xs tabular-nums">{caption}</span>
			</div>

			<div className="flex flex-wrap gap-1.5">
				{turns.map((turn, index) => (
					<button
						key={turn.id}
						type="button"
						aria-haspopup="dialog"
						onClick={(event) => onOpenSpan(turn.anchor.spanId, event.currentTarget)}
						title={`${turnOrdinal(turn)}${turn.label === undefined ? "" : ` — ${turn.label}`}`}
						className={cn(
							"flex size-8 items-center justify-center rounded-sm border font-mono text-[11px] tabular-nums",
							HEALTH_CELL[health[index] ?? "clean"],
						)}
					>
						{turn.index}
					</button>
				))}
			</div>
		</section>
	)
}

/* -------------------------------------------------------------------------- */
/* Where the time went                                                        */
/* -------------------------------------------------------------------------- */

function TimeComposition({
	summary,
	turns,
}: {
	summary: SessionSummary
	turns: readonly SessionTurn[]
}) {
	// Under half a percent a legend row reads "0%" and says nothing; the bar
	// still draws the sliver in place, so nothing disappears from the timeline.
	const legend = summary.occupancy
		.map((segment) => ({ ...segment, percent: sharePercent(segment.ms, summary.wallClockMs) }))
		.filter((segment) => segment.percent >= 0.5)
	// The bar is chronological — each interval sits where it happened on the
	// wall clock, so a mid-session stall reads as a hole in the middle, not as
	// an idle block pinned to the left.
	const wallClockMs = Math.max(summary.wallClockMs, 1)
	const caption = longestGapText(summary.idleGaps, turns)

	return (
		<section>
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h3 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.09em]">
					Where the time went
				</h3>
				{caption !== undefined && (
					<span className="font-mono text-muted-foreground text-xs tabular-nums">{caption}</span>
				)}
			</div>

			<div className="relative mt-3.5 h-4 w-full overflow-hidden rounded-sm bg-muted">
				{summary.occupancyTimeline.map((interval) => (
					<div
						key={interval.startMs}
						className={cn("absolute inset-y-0", OCCUPANCY_FILL[interval.kind])}
						style={{
							left: `${((interval.startMs - summary.startMs) / wallClockMs) * 100}%`,
							width: `${((interval.endMs - interval.startMs) / wallClockMs) * 100}%`,
						}}
					/>
				))}
			</div>

			<div className="mt-3.5 flex flex-wrap gap-x-6 gap-y-2">
				{legend.map((segment) => (
					<span key={segment.kind} className="flex items-center gap-2 text-[13px]">
						<span
							aria-hidden
							className={cn("size-2 rounded-xs", OCCUPANCY_DOT_FILL[segment.kind])}
						/>
						<span>{OCCUPANCY_LABEL[segment.kind]}</span>
						<span className="font-mono text-muted-foreground text-xs tabular-nums">
							{formatSessionDuration(segment.ms)} · {formatPercent(segment.percent / 100)}
						</span>
					</span>
				))}
			</div>
		</section>
	)
}

/** Where the session's longest hole sits — inside a turn it is a stall, between
 *  turns it is the user thinking, and the caption says which. */
function longestGapText(gaps: readonly IdleGap[], turns: readonly SessionTurn[]): string | undefined {
	const longest = [...gaps].sort((a, b) => b.durationMs - a.durationMs)[0]
	if (longest === undefined) return undefined
	const duration = formatSessionDuration(longest.durationMs)

	const inside = turns.find((turn) => longest.startMs >= turn.startMs && longest.endMs <= turn.endMs)
	if (inside !== undefined) return `longest stall ${duration}, inside ${turnOrdinal(inside).toLowerCase()}`

	const before = [...turns].reverse().find((turn) => turn.endMs <= longest.startMs)
	const after = turns.find((turn) => turn.startMs >= longest.endMs)
	if (before !== undefined && after !== undefined) {
		return `longest gap ${duration}, between ${turnOrdinal(before).toLowerCase()} and ${after.index}`
	}
	return `longest gap ${duration}`
}

/* -------------------------------------------------------------------------- */
/* Rail                                                                       */
/* -------------------------------------------------------------------------- */

function Rail({ summary }: { summary: SessionSummary }) {
	const tokenBuckets = TOKEN_BUCKETS.filter((bucket) => summary.tokens[bucket.key] > 0)
	const topModelCost = Math.max(...summary.models.map((model) => model.cost ?? 0), 0)
	const topToolCalls = summary.tools[0]?.calls ?? 0

	return (
		<aside className="flex shrink-0 flex-col gap-6 @4xl:w-[21rem] @4xl:border-border @4xl:border-l @4xl:pl-8">
			<RailSection
				title="Cost by model"
				aside={
					summary.cost === undefined ? undefined : (
						<span className="font-mono text-primary text-xs">{formatCost(summary.cost)}</span>
					)
				}
			>
				{summary.models.length === 0 ? (
					<p className="text-muted-foreground text-xs">no model calls</p>
				) : (
					summary.models.map((model) => (
						<div key={model.model} className="space-y-1.5">
							<div className="flex items-baseline justify-between gap-2">
								<span className="min-w-0 truncate font-mono text-xs" title={model.model}>
									{shortTarget(model.model)}
								</span>
								<span className="shrink-0 font-mono text-muted-foreground text-xs">
									{model.cost === undefined ? "no cost" : formatCost(model.cost)} ·{" "}
									{model.llmCalls} {model.llmCalls === 1 ? "call" : "calls"}
								</span>
							</div>
							{model.cost !== undefined && topModelCost > 0 && (
								<div className="h-1 w-full overflow-hidden rounded-xs bg-muted">
									<div
										className="h-full bg-primary"
										style={{ width: `${sharePercent(model.cost, topModelCost)}%` }}
									/>
								</div>
							)}
						</div>
					))
				)}
				{/* Cost is only ever what an instrumentation stamped on a span — Maple
				    prices nothing itself, and saying so is the difference between a
				    figure and a bill. */}
				<p className="text-[11px] text-muted-foreground leading-relaxed">
					{summary.cost === undefined
						? "No span reported a cost. Maple does not price tokens itself."
						: "As reported by the instrumentation. Not a bill."}
				</p>
			</RailSection>

			<RailSection
				title="Tokens"
				aside={
					summary.tokens.total > 0 ? (
						<span className="font-mono text-xs">{formatNumber(summary.tokens.total)}</span>
					) : undefined
				}
			>
				{summary.tokens.total === 0 ? (
					<p className="text-muted-foreground text-xs">no token usage reported</p>
				) : (
					<>
						<div className="flex h-2 w-full gap-px overflow-hidden rounded-xs bg-muted">
							{tokenBuckets.map((bucket) => (
								<div
									key={bucket.key}
									className={bucket.fill}
									style={{
										width: `${sharePercent(summary.tokens[bucket.key], summary.tokens.total)}%`,
									}}
								/>
							))}
						</div>
						{tokenBuckets.map((bucket) => (
							<div key={bucket.key} className="flex items-center gap-2.5">
								<span aria-hidden className={cn("size-1.5 rounded-xs", bucket.fill)} />
								<span className="min-w-0 flex-1 truncate text-xs">{bucket.label}</span>
								<span className="font-mono text-muted-foreground text-xs tabular-nums">
									{formatNumber(summary.tokens[bucket.key])}
								</span>
							</div>
						))}
						{summary.tokenReporting === "session-level" && (
							<p className="text-[11px] text-muted-foreground">
								Reported once for the whole session
							</p>
						)}
					</>
				)}
			</RailSection>

			{/* Two sections, not one: who ran and what they reached for are
			    different questions, and a reader scanning for one should not have
			    to read past the other. */}
			{summary.agentNames.length > 0 && (
				<RailSection title="Agents">
					<div className="flex flex-wrap items-center gap-2">
						{summary.agentNames.map((name, index) => (
							// `min-w-0 max-w-full` + truncate: an agent name is emitter
							// input, and one long enough would otherwise push the whole
							// page into a horizontal scroll.
							<span key={name} className="flex min-w-0 max-w-full items-center gap-2">
								{index > 0 && (
									<ArrowRightIcon size={12} className="shrink-0 text-muted-foreground" />
								)}
								<span
									className={cn(
										"min-w-0 truncate rounded-sm px-2 py-0.5 font-mono text-[11px]",
										index === 0
											? "bg-primary/12 text-primary"
											: "bg-muted text-muted-foreground",
									)}
									title={name}
								>
									{name}
								</span>
							</span>
						))}
					</div>
				</RailSection>
			)}

			<RailSection title="Tools">
				{summary.tools.length === 0 ? (
					<p className="text-muted-foreground text-xs">no tool calls</p>
				) : (
					summary.tools.map((tool) => (
						<ToolUsageRow key={tool.name} tool={tool} topToolCalls={topToolCalls} />
					))
				)}
			</RailSection>
		</aside>
	)
}

/**
 * One tool in the rail. Where the instrumentation stamped a
 * `gen_ai.tool.description`, the row discloses it in place — the definition the
 * model saw is a fact about the session, and the rail is where the tool is
 * already named. A tool without one has nothing to open and stays a plain row.
 */
function ToolUsageRow({ tool, topToolCalls }: { tool: SessionToolUsage; topToolCalls: number }) {
	const [open, setOpen] = useState(false)
	const disclosable = tool.description !== undefined

	const row = (
		<>
			<span className="flex w-24 shrink-0 items-center gap-1">
				{disclosable && (
					<ChevronRightIcon
						size={10}
						className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
					/>
				)}
				<span className="min-w-0 truncate font-mono text-xs" title={tool.name}>
					{tool.name}
				</span>
			</span>
			<span className="h-1 min-w-0 flex-1 overflow-hidden rounded-xs bg-muted">
				<span
					className="block h-full bg-chart-4"
					style={{ width: `${sharePercent(tool.calls, topToolCalls)}%` }}
				/>
			</span>
			<span className="w-6 shrink-0 text-right font-mono text-muted-foreground text-xs tabular-nums">
				{tool.calls}
			</span>
		</>
	)

	if (!disclosable) return <div className="flex items-center gap-2.5">{row}</div>

	return (
		<div className="flex flex-col gap-1.5">
			<button
				type="button"
				onClick={() => setOpen((previous) => !previous)}
				aria-expanded={open}
				className="-mx-1 flex cursor-pointer items-center gap-2.5 rounded-xs px-1 py-0.5 text-left hover:bg-accent/40"
			>
				{row}
			</button>
			{open && (
				<p className="break-words pl-4 text-muted-foreground text-xs leading-relaxed">
					{tool.description}
				</p>
			)}
		</div>
	)
}

function RailSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-3 border-border border-t pt-6 first:border-t-0 first:pt-0">
			<div className="flex items-baseline justify-between gap-2">
				<h3 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.09em]">
					{title}
				</h3>
				{aside}
			</div>
			{children}
		</section>
	)
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

function sharePercent(value: number, total: number): number {
	if (total <= 0) return 0
	return (value / total) * 100
}
