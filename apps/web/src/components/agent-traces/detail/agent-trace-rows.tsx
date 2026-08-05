import { memo, useState } from "react"

import { cn } from "@maple/ui/lib/utils"
import { ArrowRightIcon, ChevronDownIcon, ChevronRightIcon } from "@/components/icons"
import {
	agentColor,
	countWords,
	formatCost,
	formatAgentTraceDuration,
	formatAgentTraceOffset,
	formatTokens,
	formatTurnDuration,
} from "./agent-trace-format"
import type {
	AgentTraceIdleRow,
	AgentTraceMessageRow,
	AgentTraceRow,
	AgentTraceStructuralRow,
	AgentTraceTurnGroupRow,
} from "./agent-trace-model"
import { hasContent, isInvokeAgent } from "./agent-trace-model"
import { ContentRedactedLine, AgentTraceEventBadges } from "./agent-trace-badges"
import { AgentTraceToolCalls } from "./agent-trace-tool-calls"

// ---------------------------------------------------------------------------
// The spine and its three archetypes.
//
// Every row is `[offset] [lane?] [marker + rule] [content]`. The marker
// vocabulary is the whole event grammar — outline square for the user, filled
// square in the agent's colour for an agent, red square for a failed turn, a
// dash for a structural event, a circle for an agent boundary, a dashed rule
// for measured idle. Adding an event kind means adding a marker and a payload,
// never a new row component.
// ---------------------------------------------------------------------------

const SPINE_LABEL = "font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-foreground/75"
const META = "font-mono text-[11px] text-muted-foreground tabular-nums"

/** How much body text shows before the expand control appears. */
const BODY_CLAMP_CHARS = 460

/**
 * A ref callback the timeline hands every row so it can observe which ones are
 * on screen. Threaded as a prop rather than resolved by query selector, so the
 * observer set stays correct as rows mount, unmount, expand and collapse.
 */
export type AttachRow = (node: HTMLElement | null) => (() => void) | void

export const AgentTraceTimelineRow = memo(function AgentTraceTimelineRow({
	row,
	showToolCalls,
	expandBodies,
	streaming,
	expandedGroup,
	onToggleGroup,
	attachRow,
	maxRowDurationMs,
}: {
	row: AgentTraceRow
	showToolCalls: boolean
	expandBodies: boolean
	/** True for the single row still generating, if any. */
	streaming: boolean
	expandedGroup: boolean
	onToggleGroup: (id: string) => void
	attachRow?: AttachRow
	/** The longest row in the agent trace — the scale a redacted turn's bar reads against. */
	maxRowDurationMs: number
}) {
	switch (row.type) {
		case "message":
			return (
				<MessageRow
					row={row}
					showToolCalls={showToolCalls}
					expandBodies={expandBodies}
					streaming={streaming}
					attachRow={attachRow}
					maxRowDurationMs={maxRowDurationMs}
				/>
			)
		case "structural":
			return <StructuralRow row={row} attachRow={attachRow} />
		case "idle":
			return <IdleRow row={row} />
		case "turnGroup":
			return (
				<TurnGroupRow
					row={row}
					expanded={expandedGroup}
					onToggle={() => onToggleGroup(row.id)}
					attachRow={attachRow}
				/>
			)
	}
})

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function RowShell({
	offsetMs,
	marker,
	laneColor,
	children,
	className,
	rowId,
	attachRow,
	dashedRule = false,
	showOffset = true,
}: {
	offsetMs: number
	marker: React.ReactNode
	laneColor: string | null
	children: React.ReactNode
	className?: string
	rowId?: string
	attachRow?: AttachRow
	dashedRule?: boolean
	showOffset?: boolean
}) {
	return (
		<div className="flex" data-agent-trace-row={rowId} ref={attachRow}>
			<div className="flex w-14 shrink-0 justify-end pt-px pr-2.5">
				{showOffset && <span className={META}>{formatAgentTraceOffset(offsetMs)}</span>}
			</div>
			{/* Nested-agent lane. Present only between an `invoke_agent` and that
			    agent's return, so a delegated stretch reads as inside something. */}
			{laneColor != null && (
				<div aria-hidden className="flex w-4 shrink-0 justify-center">
					<span className="w-px grow" style={{ backgroundColor: laneColor }} />
				</div>
			)}
			<div aria-hidden className="flex w-4 shrink-0 flex-col items-center gap-1.5">
				{marker}
				<span
					className={cn(
						"w-px grow",
						dashedRule ? "border-l border-dashed border-input" : "bg-border",
					)}
				/>
			</div>
			<div className={cn("flex min-w-0 grow flex-col pb-6 pl-3.5", className)}>{children}</div>
		</div>
	)
}

function SquareMarker({ color, outline }: { color?: string; outline?: boolean }) {
	if (outline) {
		return (
			<span className="mt-0.5 size-2.5 shrink-0 rounded-[3px] border-[1.5px] border-muted-foreground" />
		)
	}
	return <span className="mt-0.5 size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />
}

function DashMarker() {
	return <span className="mt-1.5 h-[3px] w-2.5 shrink-0 rounded-[2px] bg-muted-foreground" />
}

function CircleMarker({ color, outline }: { color?: string; outline?: boolean }) {
	if (outline) {
		return (
			<span className="mt-0.5 size-2.5 shrink-0 rounded-full border-[1.5px] border-input bg-background" />
		)
	}
	return <span className="mt-0.5 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
}

// ---------------------------------------------------------------------------
// Message block
// ---------------------------------------------------------------------------

function MessageRow({
	row,
	showToolCalls,
	expandBodies,
	streaming,
	attachRow,
	maxRowDurationMs,
}: {
	row: AgentTraceMessageRow
	showToolCalls: boolean
	expandBodies: boolean
	/** Set only on the one turn still generating — see `streamingRowId`. */
	streaming: boolean
	attachRow?: AttachRow
	maxRowDurationMs: number
}) {
	const { event } = row
	const isUser = event.role === "user"
	const failed = event.status === "error"
	const color = agentColor(event.agentName)

	// "Expand all bodies" is a default this row can override, not a value it
	// mirrors: flipping the global control resets every per-row choice, but
	// expanding one message must not be undone on the next unrelated re-render.
	// Adjusted during render rather than in an effect — no second paint.
	const [override, setOverride] = useState<boolean | null>(null)
	const [lastGlobal, setLastGlobal] = useState(expandBodies)
	if (lastGlobal !== expandBodies) {
		setLastGlobal(expandBodies)
		setOverride(null)
	}
	const expanded = override ?? expandBodies
	const setExpanded = (next: boolean) => setOverride(next)

	const content = hasContent(event) ? (event.content ?? "") : null
	const needsClamp = content != null && content.length > BODY_CLAMP_CHARS
	const shown = needsClamp && !expanded ? `${content.slice(0, BODY_CLAMP_CHARS).trimEnd()}…` : content
	const remainingWords = needsClamp ? countWords(content.slice(BODY_CLAMP_CHARS)) : 0

	const speaker = isUser ? "User" : (event.agentName ?? event.role ?? "assistant")

	return (
		<RowShell
			rowId={row.id}
			attachRow={attachRow}
			offsetMs={row.offsetMs}
			laneColor={row.laneColor}
			marker={
				isUser ? (
					<SquareMarker outline />
				) : failed ? (
					<SquareMarker color="var(--severity-error)" />
				) : (
					<SquareMarker color={color} />
				)
			}
			className="gap-2"
		>
			<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
				<span className={SPINE_LABEL}>{speaker}</span>
				{!isUser && event.model != null && (
					<span className="font-mono text-xs text-muted-foreground">{event.model}</span>
				)}
				{streaming && (
					<span className="inline-flex h-[17px] items-center gap-1.5 rounded-sm bg-warning/12 px-1.5 font-mono text-[11px] leading-none font-medium text-warning-foreground dark:bg-warning/16">
						<span aria-hidden className="size-1.5 animate-pulse rounded-[3px] bg-primary" />
						STREAMING
					</span>
				)}
				<AgentTraceEventBadges event={event} />
				<span className="grow" />
				<span className={cn(META, "flex items-baseline gap-1.5")}>
					{row.durationMs != null && (
						<span className="text-foreground/75">
							{formatTurnDuration(row.durationMs)}
							{streaming && " so far"}
						</span>
					)}
					{(event.inputTokens != null || event.outputTokens != null) && (
						<>
							{row.durationMs != null && <span className="text-border">·</span>}
							<span>
								{formatTokens(event.inputTokens ?? 0)} →{" "}
								{formatTokens(event.outputTokens ?? 0)}
							</span>
						</>
					)}
					{isUser && event.inputTokens == null && event.outputTokens != null && (
						<span>{formatTokens(event.outputTokens)} tokens</span>
					)}
				</span>
			</div>

			{shown != null ? (
				<>
					<p className="max-w-[760px] font-display text-[15px] leading-6 whitespace-pre-wrap text-foreground">
						{shown}
					</p>
					{needsClamp && (
						<button
							type="button"
							onClick={() => setExpanded(!expanded)}
							className="flex items-center gap-2 pt-px text-left text-muted-foreground hover:text-foreground"
						>
							{expanded ? <ChevronDownIcon size={9} /> : <ChevronRightIcon size={9} />}
							<span className="font-mono text-[11px]">
								{expanded
									? "Collapse"
									: `Expand · ${remainingWords.toLocaleString()} more words`}
							</span>
							<span aria-hidden className="h-px max-w-[640px] grow bg-border" />
						</button>
					)}
				</>
			) : (
				// The redacted state is not an empty state. With the text gone,
				// timing becomes the only readable thing about the turn — so it gets
				// the visual weight the body would have had.
				<div className="flex flex-col gap-2">
					<ContentRedactedLine source={event.contentSource} />
					{row.durationMs != null && row.durationMs > 0 && (
						<RedactedTimingBar durationMs={row.durationMs} maxDurationMs={maxRowDurationMs} />
					)}
				</div>
			)}

			{failed && <ProviderErrorPanel event={event} />}

			{streaming && (
				<div className="flex items-center gap-2.5">
					<span aria-hidden className="h-4 w-2 animate-pulse rounded-[2px] bg-primary" />
					<span className={META}>generating</span>
				</div>
			)}

			{showToolCalls && row.toolCalls.length > 0 && <AgentTraceToolCalls calls={row.toolCalls} />}
		</RowShell>
	)
}

/**
 * The bar that stands in for a redacted body — width is the turn's share of the
 * longest turn in the agent trace. A floor of 4% keeps a fast turn a bar rather than
 * a sliver; a missing scale (every duration unknown) falls back to full width,
 * which is what "no distribution to place this in" honestly looks like.
 */
function RedactedTimingBar({ durationMs, maxDurationMs }: { durationMs: number; maxDurationMs: number }) {
	const sharePct = maxDurationMs > 0 ? Math.max(4, Math.min(100, (durationMs / maxDurationMs) * 100)) : 100
	return (
		<div
			className="h-1.5 w-full max-w-[560px] overflow-hidden rounded-[2px] bg-muted"
			title={formatTurnDuration(durationMs)}
			role="img"
			aria-label={`${formatTurnDuration(durationMs)} of model time`}
		>
			<span className="block h-full bg-primary/60" style={{ width: `${sharePct}%` }} />
		</div>
	)
}

function ProviderErrorPanel({ event }: { event: AgentTraceMessageRow["event"] }) {
	const [code, ...rest] = (event.statusMessage ?? "").split(/[:\n]/)
	const detail = rest.join(":").trim()
	return (
		<div className="flex flex-col gap-1.5 rounded-lg border border-destructive/25 bg-destructive/[0.07] px-3.5 py-3">
			<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
				<span className="font-mono text-[13px] text-destructive-foreground">
					{code.trim().length > 0 ? code.trim() : "provider error"}
				</span>
				{event.provider != null && (
					<>
						<span className="text-border">·</span>
						<span className="font-mono text-xs text-muted-foreground">from {event.provider}</span>
					</>
				)}
			</div>
			{detail.length > 0 && (
				<p className="max-w-[720px] font-mono text-xs leading-[19px] text-muted-foreground">
					{detail}
				</p>
			)}
			{(event.inputTokens ?? 0) > 0 && (
				<p className="font-mono text-[11px] text-muted-foreground">
					Billed for {formatTokens(event.inputTokens)} input tokens and produced none.
				</p>
			)}
		</div>
	)
}

// ---------------------------------------------------------------------------
// Structural bar — handoffs, invoke_agent, plan, retrieval, memory, and every
// operation the conventions have not defined yet.
// ---------------------------------------------------------------------------

function StructuralRow({ row, attachRow }: { row: AgentTraceStructuralRow; attachRow?: AttachRow }) {
	const { event } = row
	const handoff = event.kind === "agentHandoff"
	const invoke = isInvokeAgent(event)
	const color = agentColor(event.agentName)
	const cost = formatCost(event.cost)

	return (
		<RowShell
			rowId={row.id}
			attachRow={attachRow}
			offsetMs={row.offsetMs}
			laneColor={row.laneColor}
			marker={
				handoff ? <CircleMarker outline /> : invoke ? <CircleMarker color={color} /> : <DashMarker />
			}
			className="pb-5"
		>
			<div className="flex min-h-[30px] flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md bg-muted px-3 py-1.5">
				<span className="font-mono text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">
					{row.label}
				</span>
				<span aria-hidden className="h-3 w-px bg-input" />
				{handoff ? (
					<HandoffTargets event={event} />
				) : (
					<>
						{event.agentName != null && invoke && (
							<span
								aria-hidden
								className="size-1.5 rounded-[2px]"
								style={{ backgroundColor: color }}
							/>
						)}
						<span className="truncate font-mono text-xs text-foreground">
							{event.agentName ?? event.toolName ?? event.spanName}
						</span>
						{event.content != null && event.content.length > 0 && (
							<span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
								{event.content}
							</span>
						)}
					</>
				)}
				<span className="grow" />
				<span className={cn(META, "flex items-baseline gap-1.5")}>
					{row.durationMs != null && <span>{formatTurnDuration(row.durationMs)}</span>}
					{cost != null && (
						<>
							{row.durationMs != null && <span className="text-border">·</span>}
							<span>{cost}</span>
						</>
					)}
					{(event.inputTokens ?? 0) + (event.outputTokens ?? 0) > 0 && (
						<>
							<span className="text-border">·</span>
							<span>
								{formatTokens((event.inputTokens ?? 0) + (event.outputTokens ?? 0))} tokens
							</span>
						</>
					)}
				</span>
			</div>
		</RowShell>
	)
}

function HandoffTargets({ event }: { event: AgentTraceStructuralRow["event"] }) {
	// A handoff carries `from → to`. The server puts the receiving agent in
	// `agentName`; the sender, when it recorded one, is in the status message.
	const to = event.agentName ?? "next agent"
	const from = event.statusMessage?.trim()
	return (
		<span className="flex min-w-0 items-center gap-2">
			{from != null && from.length > 0 && (
				<>
					<span
						aria-hidden
						className="size-1.5 rounded-[2px]"
						style={{ backgroundColor: agentColor(from) }}
					/>
					<span className="truncate font-mono text-xs text-foreground/75">{from}</span>
					<ArrowRightIcon size={12} className="shrink-0 text-muted-foreground" />
				</>
			)}
			<span
				aria-hidden
				className="size-1.5 rounded-[2px]"
				style={{ backgroundColor: agentColor(to) }}
			/>
			<span className="truncate font-mono text-xs text-foreground">{to}</span>
		</span>
	)
}

// ---------------------------------------------------------------------------
// Measured idle — never a blank margin
// ---------------------------------------------------------------------------

function IdleRow({ row }: { row: AgentTraceIdleRow }) {
	return (
		<div className="-mt-1.5 flex">
			<div className="w-14 shrink-0 pr-2.5" />
			{row.laneColor != null && <div aria-hidden className="w-4 shrink-0" />}
			<div aria-hidden className="flex w-4 shrink-0 flex-col items-center">
				<span className="h-px w-2 shrink-0 bg-input" />
				<span className="w-px grow border-l border-dashed border-input" />
				<span className="h-px w-2 shrink-0 bg-input" />
			</div>
			<div className="flex min-w-0 grow items-center gap-2.5 pt-1.5 pb-4 pl-3.5">
				<span className={META}>{formatAgentTraceDuration(row.durationMs)} idle</span>
				<span className="text-border">·</span>
				<span className={META}>{row.reason}</span>
			</div>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Collapsed run of turns — the long-agent trace affordance
// ---------------------------------------------------------------------------

function TurnGroupRow({
	row,
	expanded,
	onToggle,
	attachRow,
}: {
	row: AgentTraceTurnGroupRow
	expanded: boolean
	onToggle: () => void
	attachRow?: AttachRow
}) {
	const cost = formatCost(row.cost)
	const leadAgent = row.agentNames[0]

	return (
		<RowShell
			rowId={row.id}
			attachRow={attachRow}
			offsetMs={row.offsetMs}
			laneColor={row.laneColor}
			marker={
				<SquareMarker color={leadAgent != null ? agentColor(leadAgent) : "var(--muted-foreground)"} />
			}
			className="pb-5"
		>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={expanded}
				className="flex flex-col gap-2.5 rounded-lg border border-border bg-muted/30 px-3.5 py-3 text-left hover:border-input"
			>
				<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
					{expanded ? (
						<ChevronDownIcon size={9} className="shrink-0 text-muted-foreground" />
					) : (
						<ChevronRightIcon size={9} className="shrink-0 text-muted-foreground" />
					)}
					<span className="font-mono text-[13px] text-foreground tabular-nums">
						{row.firstTurn === row.lastTurn
							? `turn ${row.firstTurn}`
							: `turns ${row.firstTurn}–${row.lastTurn}`}
					</span>
					{row.agentNames.length > 0 && (
						<>
							<span className="text-border">·</span>
							<span className="truncate font-mono text-xs text-muted-foreground">
								{row.agentNames.slice(0, 2).join(", ")}
								{row.agentNames.length > 2 ? ` +${row.agentNames.length - 2}` : ""}
							</span>
						</>
					)}
					<span className="grow" />
					<span className={cn(META, "flex items-baseline gap-1.5")}>
						{row.toolCallCount > 0 && (
							<>
								<span>{row.toolCallCount} tool calls</span>
								<span className="text-border">·</span>
							</>
						)}
						<span className="text-foreground/75">{formatAgentTraceDuration(row.durationMs)}</span>
						{cost != null && (
							<>
								<span className="text-border">·</span>
								<span className="text-foreground/75">{cost}</span>
							</>
						)}
					</span>
				</div>
				<div
					aria-hidden
					className="relative h-1.5 w-full overflow-hidden rounded-[2px] bg-background"
				>
					{row.segments.map((segment) => (
						<span
							key={segment.key}
							className={cn(
								"absolute inset-y-0",
								segment.category === "failed"
									? "bg-severity-error"
									: segment.category === "tool"
										? "bg-info"
										: "bg-primary",
							)}
							style={{ left: `${segment.startPct}%`, width: `${segment.widthPct}%` }}
						/>
					))}
				</div>
			</button>
		</RowShell>
	)
}
