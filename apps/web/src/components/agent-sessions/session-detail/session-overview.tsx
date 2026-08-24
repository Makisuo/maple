import { useMemo, useState, type ReactNode } from "react"

import { ArrowRightIcon, ChevronDownIcon } from "@/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { cn } from "@maple/ui/lib/utils"

import { formatCurrency } from "@/lib/billing/currency"
import { buildTurnDigest, type TurnDigest } from "@/lib/agent-sessions/session-overview"
import type {
	SessionFailureKind,
	SessionSummary,
	SessionTokenTotals,
} from "@/lib/agent-sessions/session-summary"
import type { SessionTurn } from "@/lib/agent-sessions/session-turns"
import { shortTarget } from "@/lib/agent-sessions/span-filters"
import { OCCUPANCY_DOT_FILL, OCCUPANCY_FILL, OCCUPANCY_LABEL } from "./span-visuals"

/** Rows shown before the digest elides its middle, and how many survive it. */
const DIGEST_COLLAPSE_ABOVE = 8
const DIGEST_HEAD_ROWS = 5
const DIGEST_TAIL_ROWS = 1

const TOKEN_BUCKETS = [
	{ key: "input", label: "Input", fill: "bg-chart-2" },
	{ key: "cacheRead", label: "Cache read", fill: "bg-chart-4" },
	{ key: "cacheWrite", label: "Cache write", fill: "bg-chart-5" },
	{ key: "output", label: "Output", fill: "bg-chart-1" },
	{ key: "reasoning", label: "Reasoning", fill: "bg-chart-3" },
] as const

const FAILURE_DOT = {
	error: "bg-destructive",
	contextExceeded: "bg-destructive",
	rateLimited: "bg-severity-warn",
	refusal: "bg-severity-warn",
} satisfies Record<SessionFailureKind, string>

/**
 * What happened, what it cost, what broke — the view a reader opens once and
 * leaves. It carries its own numbers rather than sharing a stat band with the
 * debug views, which is what buys the waterfall and the flow graph the whole
 * viewport next door.
 *
 * Every figure appears exactly once. The wall clock is the time bar, the spend
 * is the rail's per-model rows, the work is the digest's own header — a summary
 * block restating all three above them was three numbers to read twice.
 */
export function SessionOverview({
	turns,
	summary,
}: {
	turns: readonly SessionTurn[]
	summary: SessionSummary
}) {
	const digest = useMemo(() => buildTurnDigest(turns), [turns])

	return (
		<div className="@container flex grow flex-col gap-7 pt-5 pb-10">
			<TimeComposition summary={summary} />

			<div className="flex flex-col gap-8 @4xl:flex-row @4xl:gap-8">
				<TurnByTurn digest={digest} summary={summary} />
				<Rail summary={summary} />
			</div>
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Where the time went                                                        */
/* -------------------------------------------------------------------------- */

function TimeComposition({ summary }: { summary: SessionSummary }) {
	// Under half a percent a segment is a sub-pixel sliver beside a legend row
	// reading "0%"; the muted track behind the bar covers what it drops.
	const segments = summary.occupancy
		.map((segment) => ({ ...segment, percent: sharePercent(segment.ms, summary.wallClockMs) }))
		.filter((segment) => segment.percent >= 0.5)

	return (
		<section>
			<h3 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.09em]">
				Where the time went
			</h3>

			<div className="mt-3.5 flex h-4 w-full gap-0.5 overflow-hidden rounded-sm bg-muted">
				{segments.map((segment) => (
					<div
						key={segment.kind}
						className={OCCUPANCY_FILL[segment.kind]}
						style={{ width: `${segment.percent}%` }}
					/>
				))}
			</div>

			<div className="mt-3.5 flex flex-wrap gap-x-6 gap-y-2">
				{segments.map((segment) => (
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

/* -------------------------------------------------------------------------- */
/* Turn by turn                                                               */
/* -------------------------------------------------------------------------- */

function TurnByTurn({ digest, summary }: { digest: readonly TurnDigest[]; summary: SessionSummary }) {
	const [failedOnly, setFailedOnly] = useState(false)
	const [expanded, setExpanded] = useState(false)

	const failedCount = digest.filter((row) => row.turn.failed).length
	const rows = failedOnly ? digest.filter((row) => row.turn.failed || row.failures.length > 0) : digest
	// The middle of a long session is where a reader learns least, so it folds
	// away — but only ever the middle: the opening turns and the one the session
	// ended on stay put.
	const elided =
		expanded || rows.length <= DIGEST_COLLAPSE_ABOVE
			? 0
			: rows.length - DIGEST_HEAD_ROWS - DIGEST_TAIL_ROWS
	const head = elided === 0 ? rows : rows.slice(0, DIGEST_HEAD_ROWS)
	const tail = elided === 0 ? [] : rows.slice(-DIGEST_TAIL_ROWS)
	const gapBeforeTail = idleBefore(summary, tail[0])
	// Every turn's bar is drawn against the longest turn rather than against
	// itself, so the column reads as durations side by side instead of as
	// fourteen identical bars with different labels.
	const longestMs = Math.max(...digest.map((row) => row.turn.durationMs), 1)

	return (
		<section className="flex min-w-0 grow flex-col">
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 pb-3.5">
				<div className="flex items-baseline gap-2.5">
					<h3 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.09em]">
						Turn by turn
					</h3>
					<p className="text-muted-foreground text-xs">
						{digest.length} {digest.length === 1 ? "turn" : "turns"}
						{failedCount > 0 && ` · ${failedCount} failed`}
					</p>
				</div>
				{failedCount > 0 && (
					<div className="flex items-center gap-1.5">
						<DigestFilter pressed={!failedOnly} onClick={() => setFailedOnly(false)}>
							All turns
						</DigestFilter>
						<DigestFilter pressed={failedOnly} onClick={() => setFailedOnly(true)}>
							Failed only
						</DigestFilter>
					</div>
				)}
			</div>

			{rows.length === 0 ? (
				<p className="border-border border-t py-8 text-center text-muted-foreground text-sm">
					No failed turns in this session.
				</p>
			) : (
				<>
					{head.map((row) => (
						<TurnRow key={row.turn.id} row={row} longestMs={longestMs} />
					))}
					{elided > 0 && (
						<button
							type="button"
							onClick={() => setExpanded(true)}
							className="flex w-full items-center gap-3 border-border border-t px-3 py-2.5 text-left hover:bg-accent/40"
						>
							<span className="flex w-14 shrink-0 justify-center">
								<ChevronDownIcon size={14} className="text-muted-foreground" />
							</span>
							<span className="text-[13px] text-muted-foreground">
								{elided} {elided === 1 ? "turn" : "turns"} hidden
							</span>
							<span aria-hidden className="h-px grow bg-border" />
							{gapBeforeTail !== undefined && (
								<span className="font-mono text-muted-foreground text-xs tabular-nums">
									{formatSessionDuration(gapBeforeTail)} idle before{" "}
									{tail[0]!.ordinal.toLowerCase()}
								</span>
							)}
						</button>
					)}
					{tail.map((row) => (
						<TurnRow key={row.turn.id} row={row} longestMs={longestMs} />
					))}
				</>
			)}
		</section>
	)
}

function DigestFilter({
	pressed,
	onClick,
	children,
}: {
	pressed: boolean
	onClick: () => void
	children: string
}) {
	return (
		<Button variant={pressed ? "outline" : "ghost"} size="xs" onClick={onClick}>
			<span className={pressed ? undefined : "text-muted-foreground"}>{children}</span>
		</Button>
	)
}

function TurnRow({ row, longestMs }: { row: TurnDigest; longestMs: number }) {
	const { turn } = row
	const failed = turn.failed || row.failures.length > 0

	return (
		<div
			className={cn(
				"flex items-start gap-4 border-border border-t py-4 pr-3 pl-3",
				failed && "border-l-2 border-l-destructive bg-destructive/[0.06] pl-2.5",
			)}
		>
			<div className="w-14 shrink-0">
				<p
					className={cn(
						"font-medium font-mono text-[11px] uppercase tracking-wider",
						turn.failed ? "text-destructive" : "text-muted-foreground",
					)}
				>
					{row.ordinal}
				</p>
				<p className="mt-1 font-mono text-[11px] text-muted-foreground/70 tabular-nums">
					{clockOf(turn.startMs)}
				</p>
			</div>

			<div className="flex min-w-0 grow flex-col gap-1.5">
				{/* One line of the reader's own prompt: the digest's whole reason for
				    existing, and the reason the row is not a table cell. */}
				<p className="truncate font-medium text-sm">
					{turn.label ?? <span className="text-muted-foreground italic">no captured message</span>}
				</p>
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
					<span>
						{turn.spans.length} {turn.spans.length === 1 ? "span" : "spans"}
					</span>
					{row.models.length > 0 && <Dot />}
					{row.models.length > 0 && (
						<span className="truncate" title={row.models.map((m) => m.model).join(" · ")}>
							{row.models
								.map((model) => `${shortTarget(model.model)} ×${model.calls}`)
								.join(" · ")}
						</span>
					)}
					{row.tools.length > 0 && <Dot />}
					{row.tools.length > 0 && (
						<span className="truncate font-mono text-[11px] text-chart-4">
							{row.tools.map((tool) => labelWithCount(tool.name, tool.calls)).join("  ")}
						</span>
					)}
					{row.failures.length > 0 && <Dot />}
					{row.failures.length > 0 && (
						<span className="truncate font-mono text-[11px] text-destructive">
							{row.failures
								.map((failure) => labelWithCount(failure.label, failure.count))
								.join("  ")}
						</span>
					)}
				</div>
			</div>

			<div className="flex w-[11.5rem] shrink-0 flex-col items-end gap-1.5 pt-0.5">
				<div
					className="flex h-1 gap-px"
					// A floor, so the shortest turn in a session with one very long one
					// is still a mark rather than nothing.
					style={{ width: `${Math.max(6, sharePercent(turn.durationMs, longestMs))}%` }}
				>
					{row.occupancy.map((segment) => (
						<div
							key={segment.kind}
							className={OCCUPANCY_FILL[segment.kind]}
							style={{ width: `${sharePercent(segment.ms, turn.durationMs)}%` }}
						/>
					))}
				</div>
				{/* Fixed lanes: three ragged columns of numbers down fourteen rows are
				    three facts you have to re-find on every row. */}
				<div className="flex items-baseline font-mono text-xs tabular-nums">
					<span className="w-16 text-right">{formatSessionDuration(turn.durationMs)}</span>
					<span className="w-16 text-right text-muted-foreground">
						{row.tokens.total > 0 ? formatNumber(row.tokens.total) : "—"}
					</span>
					<span
						className={cn(
							"w-14 text-right",
							row.cost === undefined ? "text-muted-foreground" : "text-primary",
						)}
					>
						{row.cost === undefined ? "—" : formatCost(row.cost)}
					</span>
				</div>
			</div>
		</div>
	)
}

function Dot() {
	return <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-muted-foreground/50" />
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
			{summary.failureGroups.length > 0 && (
				<RailSection
					title="Failures"
					aside={
						<span className="font-mono text-destructive text-xs">
							{summary.failureGroups.reduce((total, group) => total + group.count, 0)} events
						</span>
					}
				>
					{summary.failureGroups.map((group) => (
						<div key={group.label} className="flex items-center gap-2.5">
							<span
								aria-hidden
								className={cn("size-1.5 shrink-0 rounded-full", FAILURE_DOT[group.kind])}
							/>
							<span className="min-w-0 flex-1 truncate font-mono text-xs">{group.label}</span>
							<span className="font-mono text-muted-foreground text-xs tabular-nums">
								{group.count}
							</span>
						</div>
					))}
				</RailSection>
			)}

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
										width: `${sharePercent(summary.tokens[bucket.key], bucketSpan(summary.tokens, tokenBuckets))}%`,
									}}
								/>
							))}
						</div>
						{tokenBuckets.map((bucket) => (
							<div key={bucket.key} className="flex items-center gap-2.5">
								<span aria-hidden className={cn("size-1.5 rounded-xs", bucket.fill)} />
								<span
									className={cn(
										"min-w-0 flex-1 truncate text-xs",
										bucket.key === "cacheRead" && "text-muted-foreground",
									)}
								>
									{bucket.label}
									{bucket.key === "cacheRead" && " (subset of input)"}
								</span>
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

			<RailSection title="Agents & tools">
				{summary.agentNames.length > 0 && (
					<div className="flex flex-wrap items-center gap-2">
						{summary.agentNames.map((name, index) => (
							<span key={name} className="flex items-center gap-2">
								{index > 0 && <ArrowRightIcon size={12} className="text-muted-foreground" />}
								<span
									className={cn(
										"rounded-sm px-2 py-0.5 font-mono text-[11px]",
										index === 0
											? "bg-primary/12 text-primary"
											: "bg-muted text-muted-foreground",
									)}
								>
									{name}
								</span>
							</span>
						))}
					</div>
				)}
				{summary.tools.length === 0 ? (
					<p className="text-muted-foreground text-xs">no tool calls</p>
				) : (
					summary.tools.map((tool) => (
						<div key={tool.name} className="flex items-center gap-2.5">
							<span className="w-24 shrink-0 truncate font-mono text-xs" title={tool.name}>
								{tool.name}
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
						</div>
					))
				)}
			</RailSection>
		</aside>
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

/** The bar draws every bucket, so it scales to what the buckets add up to —
 *  which under the inclusive cache convention is more than the total billed. */
function bucketSpan(
	tokens: SessionTokenTotals,
	buckets: readonly { key: keyof SessionTokenTotals }[],
): number {
	return buckets.reduce((total, bucket) => total + tokens[bucket.key], 0)
}

/** A $0.0004 session printed "$0.00" reads as "measured, and it was free". */
function formatCost(usd: number): string {
	return usd > 0 && usd < 0.01 ? "<$0.01" : formatCurrency(usd, "usd")
}

function labelWithCount(label: string, count: number): string {
	return count === 1 ? label : `${label} ×${count}`
}

function clockOf(epochMs: number): string {
	return new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

/** The idle gap immediately before a turn, when the digest elided it. */
function idleBefore(summary: SessionSummary, row: TurnDigest | undefined): number | undefined {
	if (row === undefined) return undefined
	const gaps = summary.idleGaps.filter((gap) => gap.endMs <= row.turn.startMs)
	return gaps[gaps.length - 1]?.durationMs
}
