import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"

import type { AiSessionSpan } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { formatBytes, formatDuration, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import {
	AlertWarningIcon,
	BranchForkIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleInfoIcon,
	CircleQuestionIcon,
	CircleWarningIcon,
	CompactLinesIcon,
	CornerDownLeftIcon,
	ExternalLinkIcon,
	FaceRobotIcon,
	GearIcon,
	PixelSparkleIcon,
	UserIcon,
	type IconComponent,
} from "@/components/icons"
import { usePageScrollMargin } from "@/hooks/use-page-scroll-margin"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { spanTokenBuckets } from "@/lib/agent-sessions/session-summary"
import { spanModel, spanTtftMs, type SessionTurn } from "@/lib/agent-sessions/session-turns"
import {
	buildTranscript,
	type CaptureCoverage,
	type TranscriptLaneRef,
	type TranscriptPayload,
	type TranscriptRow,
} from "@/lib/agent-sessions/session-transcript"
import { ClampedText } from "./clamped-text"
import { formatCost } from "./session-overview"

/**
 * The session as a conversation.
 *
 * Every rule about WHAT to show lives in `session-transcript.ts`; this file is
 * the reading of it. Rows arrive flat and pre-ordered, so all this does is give
 * each kind its shape, and virtualize the list on the page's own scroller —
 * heights are the content's, so every row is measured rather than estimated.
 */

/** The clock gutter. Fixed so timestamps form one lane down the whole page. */
const GUTTER = "w-[88px] shrink-0 pr-3 text-right font-mono text-[11px] text-muted-foreground tabular-nums"
/** Prose column: past this a line is too long to track back to its own start. */
const BODY = "min-w-0 max-w-[900px] grow pl-4"
const LABEL = "shrink-0 font-mono font-semibold text-[11px] uppercase tracking-[0.08em]"
const META = "min-w-0 truncate font-mono text-[11px] text-muted-foreground"
/** One lane of nesting; the hairline is what makes a lane's extent visible. */
const INDENT = "flex w-6 shrink-0 justify-center"

/** Starting guesses only — `measureElement` replaces each on mount. */
const ROW_ESTIMATE = {
	turn: 38,
	user: 92,
	system: 42,
	assistant: 100,
	prompt: 130,
	thinking: 42,
	tool: 180,
	"lane-open": 44,
	"lane-close": 34,
	parallel: 46,
	structure: 30,
	note: 86,
	divider: 60,
} satisfies Partial<Record<TranscriptRow["kind"], number>>

export function SessionTranscript({
	turns,
	toolResults,
	query,
	showThinking,
	showPayloads,
	truncated,
	collapsedTurns,
	onToggleTurn,
	selectedSpanId,
	onSelectSpan,
	onOpenTraceView,
}: {
	turns: readonly SessionTurn[]
	/** The session's captured tool results by call id (`sessionToolResults`). */
	toolResults: ReadonlyMap<string, string>
	query: string
	/** The toolbar's "Thinking" chip. */
	showThinking: boolean
	/** The toolbar's "Tool payloads" chip: arguments and results open by default. */
	showPayloads: boolean
	/** The response dropped the END of the session. */
	truncated: boolean
	collapsedTurns: ReadonlySet<string>
	onToggleTurn: (turnId: string) => void
	selectedSpanId: string | undefined
	onSelectSpan: (spanId: string | undefined) => void
	/** Switch to the Traces view with this span still selected. */
	onOpenTraceView: () => void
}) {
	const { ref: listRef, getScrollElement, scrollMargin } = usePageScrollMargin()
	const { effectiveTimezone } = useTimezonePreference()

	const rows = useMemo(
		() =>
			buildTranscript({ turns, toolResults, query, showThinking, truncated, collapsedTurns }),
		[turns, toolResults, query, showThinking, truncated, collapsedTurns],
	)

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement,
		// Every row's height is its content's, so the estimate only has to be in
		// the right order of magnitude before the measurement lands.
		estimateSize: (index) => ROW_ESTIMATE[rows[index]!.kind] ?? 40,
		getItemKey: (index) => rows[index]!.key,
		overscan: 12,
		scrollMargin,
	})

	const indexByKey = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows])
	const jumpTo = (key: string) => {
		const index = indexByKey.get(key)
		if (index !== undefined) virtualizer.scrollToIndex(index, { align: "start" })
	}

	// A pasted `?span=` link lands on the block it names. Once, on mount — after
	// that the URL follows the reader rather than leading them.
	const didInitialScroll = useRef(false)
	useEffect(() => {
		if (didInitialScroll.current) return
		didInitialScroll.current = true
		if (selectedSpanId === undefined) return
		const index = rows.findIndex((row) => "span" in row && row.span.spanId === selectedSpanId)
		if (index !== -1) virtualizer.scrollToIndex(index, { align: "center" })
	}, [selectedSpanId, rows, virtualizer])

	if (rows.length === 0) {
		return (
			<p className="px-2.5 py-8 text-center text-muted-foreground text-sm">
				{query.trim() === ""
					? "No AI activity in this session — its spans are HTTP and database work, which the transcript excludes. The Traces view shows them."
					: "No blocks match this filter."}
			</p>
		)
	}

	return (
		<div ref={listRef} className="pt-2">
			<div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
				{virtualizer.getVirtualItems().map((item) => {
					const row = rows[item.index]!
					return (
						<div
							key={item.key}
							ref={virtualizer.measureElement}
							data-index={item.index}
							className="absolute inset-x-0 top-0"
							// `start` is in the page scroller's coordinates; the margin
							// brings it back to this list's own.
							style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
						>
							<TranscriptBlock
								row={row}
								timeZone={effectiveTimezone}
								showPayloads={showPayloads}
								collapsed={row.kind === "turn" && collapsedTurns.has(row.turn.id)}
								onToggleTurn={onToggleTurn}
								selected={"span" in row && row.span.spanId === selectedSpanId}
								onSelectSpan={onSelectSpan}
								onOpenTraceView={onOpenTraceView}
								onJump={jumpTo}
							/>
						</div>
					)
				})}
			</div>
		</div>
	)
}

interface BlockProps {
	row: TranscriptRow
	timeZone: string
	showPayloads: boolean
	collapsed: boolean
	onToggleTurn: (turnId: string) => void
	selected: boolean
	onSelectSpan: (spanId: string | undefined) => void
	onOpenTraceView: () => void
	onJump: (key: string) => void
}

function TranscriptBlock(props: BlockProps) {
	const { row } = props
	switch (row.kind) {
		case "turn":
			return <TurnChapter {...props} row={row} />
		case "user":
			return <UserBlock {...props} row={row} />
		case "system":
			return <SystemBlock {...props} row={row} />
		case "assistant":
			return <AssistantBlock {...props} row={row} />
		case "prompt":
			return <PromptBlock {...props} row={row} />
		case "thinking":
			return <ThinkingBlock {...props} row={row} />
		case "tool":
			return <ToolBlock {...props} row={row} />
		case "lane-open":
			return <LaneOpen {...props} row={row} />
		case "lane-close":
			return <LaneClose row={row} />
		case "parallel":
			return <ParallelMarker {...props} row={row} />
		case "structure":
			return <StructureRow {...props} row={row} />
		case "note":
			return <NoteBlock row={row} />
		case "divider":
			return <DividerBlock {...props} row={row} />
	}
}

/* -------------------------------------------------------------------------- */
/* Shell                                                                      */
/* -------------------------------------------------------------------------- */

/** The gutter / indent / rail / body frame every block shares. */
function Row({
	time,
	depth,
	rail,
	railWide = false,
	timePadding = "pt-0.5",
	/** A marker spans the column instead of sitting in the prose lane. */
	flush = false,
	className,
	children,
}: {
	time?: string
	depth: number
	/** Background class for the block's rail, or none for a full-width marker. */
	rail?: string
	railWide?: boolean
	timePadding?: string
	flush?: boolean
	className?: string
	children: ReactNode
}) {
	return (
		<div className={cn("flex", className)}>
			<span className={cn(GUTTER, timePadding)}>{time}</span>
			{Array.from({ length: depth }, (_, index) => (
				<span key={index} aria-hidden className={INDENT}>
					<span className="w-px bg-border" />
				</span>
			))}
			{rail !== undefined && (
				<span
					aria-hidden
					className={cn("shrink-0 rounded-xs", railWide ? "w-[3px]" : "w-0.5", rail)}
				/>
			)}
			<div className={flush ? "min-w-0 grow" : BODY}>{children}</div>
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Turn chapter                                                               */
/* -------------------------------------------------------------------------- */

function TurnChapter({
	row,
	timeZone,
	collapsed,
	onToggleTurn,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "turn" }> }) {
	const { turn } = row
	// A trace-anchored turn is the fallback partition — one turn per trace — so
	// it is a segment of the session, not an established exchange with the user.
	const ordinal = `${turn.anchorKind === "trace" ? "Segment" : "Turn"} ${turn.index}`

	return (
		<div className="mt-5 flex items-center border-border border-b pb-2">
			<span className={cn(GUTTER, "pt-0")}>{clockOf(turn.startMs, timeZone)}</span>
			<button
				type="button"
				onClick={() => onToggleTurn(turn.id)}
				aria-expanded={!collapsed}
				className={cn(
					"flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xs text-left",
					"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
				)}
			>
				{collapsed ? (
					<ChevronRightIcon size={12} className="shrink-0 text-muted-foreground" />
				) : (
					<ChevronDownIcon size={12} className="shrink-0 text-muted-foreground" />
				)}
				<span className={cn(LABEL, "text-primary")}>{ordinal.toUpperCase()}</span>
				{/* The label is the first prose line of a captured message, not a
				    verbatim quote, so it is set as text rather than quoted. */}
				<span className="min-w-0 truncate font-medium text-[13px]">
					{turn.label ?? <span className="text-muted-foreground italic">no prompt captured</span>}
				</span>
				{turn.agentName !== undefined && <AgentPill name={turn.agentName} />}
				{turn.failed && (
					<span className="shrink-0 rounded-sm bg-destructive/12 px-1.5 py-px font-mono text-[11px] text-destructive">
						failed
					</span>
				)}
				{collapsed && (
					<span className={cn(META, "shrink-0")}>
						{summariseTurn(row)}
					</span>
				)}
				<span className="grow" />
				<span className={cn(META, "shrink-0")}>
					{turn.traceIds.length} trace{turn.traceIds.length === 1 ? "" : "s"} ·{" "}
					{turn.spans.length} spans · {formatDuration(turn.durationMs)}
				</span>
			</button>
		</div>
	)
}

/** A collapsed chapter keeps its whole summary on the header row, so a long
 *  session can be skimmed one line per turn. */
function summariseTurn(row: Extract<TranscriptRow, { kind: "turn" }>): string {
	const parts = [`${row.llmCalls} LLM call${row.llmCalls === 1 ? "" : "s"}`]
	if (row.toolNames.length > 0) parts.push(row.toolNames.join(", "))
	return parts.join(" · ")
}

function AgentPill({ name }: { name: string }) {
	return (
		<span className="flex shrink-0 items-center gap-1.5 rounded-sm bg-primary/12 px-1.5 py-px font-mono text-[11px] text-primary">
			<span aria-hidden className="size-1 rounded-full bg-primary" />
			{name}
		</span>
	)
}

/* -------------------------------------------------------------------------- */
/* Message blocks                                                             */
/* -------------------------------------------------------------------------- */

function UserBlock({
	row,
	timeZone,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "user" }> }) {
	const [showHistory, setShowHistory] = useState(false)

	return (
		<Row time={clockOf(row.startMs, timeZone)} depth={row.depth} rail="bg-foreground" className="pt-5">
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2.5">
					<UserIcon size={13} className="shrink-0 text-foreground" />
					<span className={cn(LABEL, "text-foreground")}>User</span>
					<span className={META}>
						new input
						{row.earlierCount > 0 &&
							` · ${row.earlierCount} earlier message${row.earlierCount === 1 ? "" : "s"} re-sent and deduped`}
					</span>
					<span className="grow" />
					{row.earlierCount > 0 && (
						<button
							type="button"
							onClick={() => setShowHistory((previous) => !previous)}
							className="shrink-0 cursor-pointer text-[11px] text-chart-2 hover:underline"
						>
							{showHistory ? "hide full history" : "show full history"}
						</button>
					)}
				</div>
				<p className="whitespace-pre-wrap break-words text-foreground text-sm leading-relaxed">
					{row.text}
				</p>
				{showHistory && (
					<div className="flex flex-col gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5">
						{/* The history verbatim, not a diff: dropped and truncated
						    messages make a suffix diff unreliable, so what the model was
						    actually sent is shown whole instead of guessed at. */}
						<p className="text-[11px] text-muted-foreground">
							The whole history this call re-sent, as captured.
						</p>
						{row.history.map((message, index) => (
							<div key={index} className="flex flex-col gap-1">
								<span className={cn(LABEL, "text-muted-foreground")}>{message.role}</span>
								<ClampedText
									text={message.parts
										.map((part) => (part.kind === "text" ? part.text : `[${part.kind}]`))
										.join("\n")}
									clampClass="line-clamp-[6]"
								/>
							</div>
						))}
					</div>
				)}
			</div>
		</Row>
	)
}

/** System instructions collapse to one line: emitters re-send them on every
 *  call and they are rarely what the reader came for. */
function SystemBlock({
	row,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "system" }> }) {
	const [open, setOpen] = useState(false)

	return (
		<Row depth={row.depth} rail="bg-muted-foreground/40" className="pt-3.5">
			<button
				type="button"
				onClick={() => setOpen((previous) => !previous)}
				aria-expanded={open}
				className="flex w-full cursor-pointer items-center gap-2.5 py-1 text-left"
			>
				{open ? (
					<ChevronDownIcon size={11} className="shrink-0 text-muted-foreground" />
				) : (
					<ChevronRightIcon size={11} className="shrink-0 text-muted-foreground" />
				)}
				<span className={cn(LABEL, "text-muted-foreground")}>System</span>
				{!open && (
					<span className="min-w-0 grow truncate text-muted-foreground text-xs">
						{firstLine(row.text)}
					</span>
				)}
				<span className="grow" />
				{row.callCount > 1 && (
					<span className={cn(META, "shrink-0")}>
						identical across all {row.callCount} calls this turn
					</span>
				)}
			</button>
			{open && (
				<div className="pb-2 pl-6">
					<ClampedText text={row.text} />
				</div>
			)}
		</Row>
	)
}

function AssistantBlock({
	row,
	timeZone,
	selected,
	onSelectSpan,
	onOpenTraceView,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "assistant" }> }) {
	const tone = row.failed ? "text-destructive" : "text-chart-2"
	const Glyph = row.failed ? CircleWarningIcon : PixelSparkleIcon

	return (
		<Row
			time={clockOf(row.startMs, timeZone)}
			depth={row.depth}
			rail={row.failed ? "bg-destructive" : "bg-chart-2"}
			railWide={selected}
			className={cn("mt-2 pt-4 pb-3.5", selected && "rounded-md bg-card")}
		>
			<div className="flex items-center gap-2.5">
				{/* The header selects the block; the actions are siblings of it, never
				    nested inside — a control inside a control is not a control. */}
				<button
					type="button"
					onClick={() => onSelectSpan(selected ? undefined : row.span.spanId)}
					aria-current={selected || undefined}
					className="flex min-w-0 grow cursor-pointer items-center gap-2.5 text-left"
				>
					<Glyph size={13} className={cn("shrink-0", tone)} />
					<span className={cn(LABEL, tone)}>Assistant</span>
					{row.failed && <span className={cn(LABEL, "text-destructive")}>· Failed</span>}
					<span className={META}>{callMetaLine(row.span)}</span>
				</button>
				{row.span.genAi.errorType !== undefined && (
					<span className="shrink-0 rounded-sm bg-destructive/12 px-1.5 py-px font-mono text-[11px] text-destructive">
						error.type {row.span.genAi.errorType}
					</span>
				)}
				{selected && <OpenInTraces span={row.span} onOpenTraceView={onOpenTraceView} />}
			</div>
			{row.text !== undefined && (
				<p className="whitespace-pre-wrap break-words pt-2.5 text-foreground text-sm leading-relaxed">
					{row.text}
				</p>
			)}
			{row.failed && (
				<div className="flex flex-col gap-1.5 pt-2.5">
					{row.span.statusMessage !== "" && (
						<p className="whitespace-pre-wrap break-words font-mono text-[13px] text-destructive/90 leading-relaxed">
							{row.span.statusMessage}
						</p>
					)}
					{/* Never "the agent gave up": what the span supports is that this
					    call produced nothing. A retry, if there was one, is its own row. */}
					<p className="text-muted-foreground text-xs">No reply was produced by this call.</p>
				</div>
			)}
			{!row.failed && row.text === undefined && (
				<InlineNote className="mt-2.5">
					The reply isn't captured. This emitter recorded the request but not{" "}
					<span className="font-mono">gen_ai.output.messages</span>, so the call's text is gone —
					it did not fail.
				</InlineNote>
			)}
		</Row>
	)
}

/** A captured prompt whose reply the emitter never recorded. */
function PromptBlock({
	row,
	timeZone,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "prompt" }> }) {
	return (
		<Row time={clockOf(row.startMs, timeZone)} depth={row.depth} rail="bg-chart-2" className="pt-3">
			<div className="flex flex-col gap-2.5">
				<div className="flex items-center gap-2.5">
					<PixelSparkleIcon size={13} className="shrink-0 text-chart-2" />
					<span className={cn(LABEL, "text-chart-2")}>Prompt</span>
					<span className={META}>{callMetaLine(row.span)}</span>
					<span className="grow" />
					<span className={cn(META, "shrink-0")}>{row.span.serviceName}</span>
				</div>
				<p className="whitespace-pre-wrap break-words text-foreground text-sm leading-relaxed">
					{row.text}
				</p>
				<InlineNote>
					The reply isn't captured. This emitter records{" "}
					<span className="font-mono">gen_ai.input.messages</span> but not{" "}
					<span className="font-mono">gen_ai.output.messages</span> — the call finished normally,
					but the text is gone.
				</InlineNote>
			</div>
		</Row>
	)
}

/** Reasoning is the model thinking, not the model answering: collapsed by
 *  default, and never set as assistant prose. */
function ThinkingBlock({
	row,
	timeZone,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "thinking" }> }) {
	const [open, setOpen] = useState(false)
	const reasoningTokens = row.span.genAi.usageReasoningOutputTokens

	return (
		<Row time={clockOf(row.startMs, timeZone)} depth={row.depth} rail="bg-chart-5" className="pt-3.5">
			<button
				type="button"
				onClick={() => setOpen((previous) => !previous)}
				aria-expanded={open}
				disabled={row.text === undefined}
				className="flex w-full items-center gap-2.5 py-1 text-left enabled:cursor-pointer"
			>
				{row.text !== undefined &&
					(open ? (
						<ChevronDownIcon size={11} className="shrink-0 text-chart-5" />
					) : (
						<ChevronRightIcon size={11} className="shrink-0 text-chart-5" />
					))}
				<span className={cn(LABEL, "text-chart-5")}>Thinking</span>
				{row.redacted ? (
					<span className="shrink-0 text-muted-foreground text-xs">
						redacted by the provider
					</span>
				) : (
					<span className="shrink-0 text-muted-foreground text-xs">
						{row.text === undefined ? "no reasoning text captured" : "reasoning"}
					</span>
				)}
				{reasoningTokens !== undefined && reasoningTokens > 0 && (
					<>
						<span aria-hidden className="h-2.5 w-px shrink-0 bg-border" />
						<span className={cn(META, "shrink-0")}>
							{formatNumber(reasoningTokens)} reasoning tok
						</span>
					</>
				)}
				<span className="grow" />
				<span className={cn(META, "shrink-0")}>model reasoning, not shown to the user</span>
			</button>
			{open && row.text !== undefined && (
				<div className="mb-1 rounded-md bg-chart-5/6 px-3 py-2.5">
					<ClampedText text={row.text} />
				</div>
			)}
		</Row>
	)
}

/* -------------------------------------------------------------------------- */
/* Tool card                                                                  */
/* -------------------------------------------------------------------------- */

function ToolBlock({
	row,
	timeZone,
	showPayloads,
	selected,
	onSelectSpan,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "tool" }> }) {
	const [openOverride, setOpenOverride] = useState<boolean | undefined>(undefined)
	const open = openOverride ?? showPayloads
	const tone = row.failed ? "text-destructive" : "text-chart-4"

	return (
		<Row
			time={clockOf(row.startMs, timeZone)}
			depth={row.depth}
			rail={row.failed ? "bg-destructive" : "bg-chart-4"}
			timePadding="pt-2.5"
			className="pt-3.5"
		>
			<div
				className={cn(
					"flex min-w-0 flex-col overflow-hidden rounded-md border",
					row.failed ? "border-destructive/40 bg-destructive/5" : "border-border bg-card",
					selected && "ring-1 ring-primary",
				)}
			>
				<button
					type="button"
					onClick={() => onSelectSpan(selected ? undefined : row.span.spanId)}
					className="flex h-9 cursor-pointer items-center gap-2.5 px-3 text-left"
				>
					<GearIcon size={13} className={cn("shrink-0", tone)} />
					<span className={cn(LABEL, tone)}>Tool</span>
					<span className="shrink-0 font-medium font-mono text-foreground text-xs">
						{row.toolName ?? row.span.spanName}
					</span>
					<span className={cn(META, "shrink-0")}>
						· {row.span.serviceName}
						{!row.fromMessageOnly && ` · ${formatDuration(row.span.durationMs)}`}
						{!open && payloadSummary(row)}
					</span>
					<span className="grow" />
					{row.failed && row.span.genAi.errorType !== undefined && (
						<span className="shrink-0 rounded-sm bg-destructive/12 px-1.5 py-px font-mono text-[11px] text-destructive">
							error.type {row.span.genAi.errorType}
						</span>
					)}
					{!row.failed && row.callId !== undefined && (
						<span className={cn(META, "shrink-0")}>{row.callId}</span>
					)}
				</button>

				{open ? (
					<>
						{row.args !== undefined && (
							<PayloadSection label="Arguments" payload={row.args} />
						)}
						{row.result !== undefined ? (
							<PayloadSection
								label="Result"
								payload={row.result}
								meta={row.failed ? `span status ${row.span.statusCode}` : undefined}
								tone={row.failed ? "text-destructive/90" : undefined}
								bordered={row.args !== undefined}
							/>
						) : (
							<MissingResult fromMessageOnly={row.fromMessageOnly} />
						)}
					</>
				) : (
					<button
						type="button"
						onClick={() => setOpenOverride(true)}
						className="flex cursor-pointer items-center gap-2 border-border/60 border-t px-3 py-1.5 text-chart-2 text-xs"
					>
						<ChevronRightIcon size={11} />
						expand payloads
					</button>
				)}
			</div>
		</Row>
	)
}

/** The one-line stand-in when payloads are collapsed — sizes, so the reader
 *  knows what expanding costs them. */
function payloadSummary(row: Extract<TranscriptRow, { kind: "tool" }>): string {
	const parts: string[] = []
	if (row.args !== undefined) parts.push(`args ${formatBytes(row.args.byteLength)}`)
	parts.push(row.result === undefined ? "no result" : `result ${formatBytes(row.result.byteLength)}`)
	return ` · ${parts.join(" · ")}`
}

function PayloadSection({
	label,
	payload,
	meta,
	tone,
	bordered = true,
}: {
	label: string
	payload: TranscriptPayload
	meta?: string
	tone?: string
	bordered?: boolean
}) {
	return (
		<div className={cn("flex flex-col gap-2 px-3 pt-2.5 pb-3", bordered && "border-border/60 border-t")}>
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-[0.1em]">
					{label}
				</span>
				<span className="font-mono text-[10px] text-muted-foreground">
					{[meta, formatBytes(payload.byteLength), payload.lineCount > 1 && `${payload.lineCount} lines`]
						.filter((part): part is string => typeof part === "string")
						.join(" · ")}
				</span>
				{/* Emitter truncation, not the view's clamping — there is no "show
				    full" that can recover what was never recorded. */}
				{payload.truncatedByEmitter && (
					<span className="rounded-sm bg-severity-warn/12 px-1.5 py-px font-mono text-[10px] text-severity-warn">
						truncated by the emitter
					</span>
				)}
			</div>
			<ClampedText text={payload.text} mono clampClass="line-clamp-[14]" toneClass={tone} />
			{payload.truncatedByEmitter && (
				<p className="text-[11px] text-muted-foreground italic">
					Cut off here by the instrumentation, not by Maple — the tail was never recorded.
				</p>
			)}
		</div>
	)
}

/** A missing result is not a successful one, and this row refuses to imply it. */
function MissingResult({ fromMessageOnly }: { fromMessageOnly: boolean }) {
	return (
		<div className="flex items-center gap-2.5 border-input border-t border-dashed bg-muted/20 px-3 py-2.5">
			<CircleQuestionIcon size={13} className="shrink-0 text-muted-foreground" />
			<span className="font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-[0.1em]">
				Result
			</span>
			<span className="min-w-0 text-muted-foreground text-xs">
				{fromMessageOnly
					? "not captured — this call is known only from the message that made it. Whether it ran is unknown."
					: "not captured — the span carries no result attribute and no later message echoes this call id. Whether it succeeded is unknown."}
			</span>
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Lanes, markers, dividers                                                   */
/* -------------------------------------------------------------------------- */

function LaneOpen({
	row,
	timeZone,
	onJump,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "lane-open" }> }) {
	return (
		<Row
			time={clockOf(row.startMs, timeZone)}
			depth={row.depth}
			rail="bg-chart-1"
			timePadding="pt-2"
			className="pt-2.5"
		>
			<div className="flex items-center gap-2.5 py-1.5">
				<FaceRobotIcon size={14} className="shrink-0 text-chart-1" />
				<span className={cn(LABEL, "text-chart-1")}>
					{row.laneKind === "subagent" ? "Subagent" : "Agent"}
				</span>
				<span className="shrink-0 font-medium font-mono text-foreground text-xs">
					{row.agentName}
				</span>
				<span className={cn(META, "shrink-0")}>
					{row.laneKind === "subagent" && row.parentAgentName !== undefined
						? `· invoked by ${row.parentAgentName}`
						: `· trace ${row.span.traceId.slice(0, 8)}`}{" "}
					· {row.spanCount} spans · {formatDuration(row.span.durationMs)}
				</span>
				{row.parallelWith.length === 0 ? (
					<span aria-hidden className="h-px grow bg-border" />
				) : (
					<>
						<span className="grow" />
						{row.parallelWith.map((ref) => (
							<ParallelJump key={ref.key} target={ref} onJump={onJump} />
						))}
					</>
				)}
			</div>
		</Row>
	)
}

function ParallelJump({
	target,
	onJump,
}: {
	target: TranscriptLaneRef
	onJump: (key: string) => void
}) {
	return (
		<button
			type="button"
			onClick={() => onJump(target.key)}
			className="shrink-0 cursor-pointer rounded-sm bg-primary/12 px-2 py-0.5 text-[11px] text-primary hover:bg-primary/20"
		>
			ran in parallel with {target.agentName}
		</button>
	)
}

function LaneClose({ row }: { row: Extract<TranscriptRow, { kind: "lane-close" }> }) {
	return (
		<Row depth={row.depth} className="pt-2">
			<div className="flex items-center gap-2.5 py-1">
				<CornerDownLeftIcon size={12} className="shrink-0 text-muted-foreground" />
				<span className="shrink-0 text-muted-foreground text-xs">
					{row.agentName}
					{row.parentAgentName === undefined ? " finished" : ` returned to ${row.parentAgentName}`} ·{" "}
					{formatDuration(row.durationMs)} · {row.llmCalls} LLM call
					{row.llmCalls === 1 ? "" : "s"} · {row.toolCalls} tool call
					{row.toolCalls === 1 ? "" : "s"}
				</span>
				<span aria-hidden className="h-px grow bg-border" />
			</div>
		</Row>
	)
}

/**
 * Where a thread forked. Each lane below still reads whole and in order — the
 * marker is what stops "db-lane, then trace-lane" from reading as a sequence.
 */
function ParallelMarker({
	row,
	timeZone,
	onJump,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "parallel" }> }) {
	return (
		<Row time={clockOf(row.startMs, timeZone)} depth={row.depth} timePadding="pt-1.5" className="pt-5" flush>
			<div className="flex items-center gap-2.5">
				<BranchForkIcon size={14} className="shrink-0 text-primary" />
				<span className={cn(LABEL, "text-primary")}>Parallel</span>
				<span className="shrink-0 text-muted-foreground text-xs">
					{row.forkedBy === undefined ? "This turn" : row.forkedBy} forked {row.lanes.length} lanes —
					they overlap {clockOf(row.startMs, timeZone)} → {clockOf(row.endMs, timeZone)}. Each lane is
					shown whole, in order:
				</span>
				{row.lanes.map((lane) => (
					<button
						key={lane.key}
						type="button"
						onClick={() => onJump(lane.key)}
						className="shrink-0 cursor-pointer font-mono text-[11px] text-primary hover:underline"
					>
						{lane.agentName}
					</button>
				))}
				<span aria-hidden className="h-px grow bg-border" />
			</div>
		</Row>
	)
}

/** A model or tool call reduced to what it was: the fallback when the emitter
 *  captured no content, and the common case in production. */
function StructureRow({
	row,
	timeZone,
	selected,
	onSelectSpan,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "structure" }> }) {
	const category = row.label.startsWith("tool ")
		? "tool"
		: row.label.startsWith("agent ")
			? "agent"
			: "inference"
	const Glyph: IconComponent =
		category === "tool" ? GearIcon : category === "agent" ? FaceRobotIcon : PixelSparkleIcon
	const tone = row.failed
		? "text-destructive"
		: category === "tool"
			? "text-chart-4"
			: category === "agent"
				? "text-chart-1"
				: "text-chart-2"
	const rail = row.failed
		? "bg-destructive"
		: category === "tool"
			? "bg-chart-4"
			: category === "agent"
				? "bg-chart-1"
				: "bg-chart-2"

	return (
		<Row
			time={clockOf(row.startMs, timeZone)}
			depth={row.depth}
			rail={rail}
			timePadding="pt-1.5"
			className="pt-1"
		>
			<button
				type="button"
				onClick={() => onSelectSpan(selected ? undefined : row.span.spanId)}
				className={cn(
					"flex w-full cursor-pointer items-center gap-2.5 rounded-sm py-1 text-left hover:bg-accent/30",
					selected && "bg-primary/6",
				)}
			>
				<Glyph size={13} className={cn("shrink-0", tone)} />
				<span className="shrink-0 font-medium font-mono text-foreground text-xs">{row.label}</span>
				<span className={META}>{structureMeta(row.span, category)}</span>
				<span className="grow" />
				<span className={cn(META, "shrink-0")}>{formatDuration(row.span.durationMs)}</span>
			</button>
		</Row>
	)
}

/** What an emitter records, in the reader's words rather than attribute names. */
const CAPTURES_LABEL = {
	both: "prompts and replies",
	input: "prompts but not replies",
	output: "replies but not prompts",
	none: "no message content",
} satisfies Record<CaptureCoverage, string>

function NoteBlock({ row }: { row: Extract<TranscriptRow, { kind: "note" }> }) {
	if (row.noteKind === "capture-boundary") {
		return (
			<Row depth={row.depth} className="pt-5" flush>
				<div className="flex items-center gap-2.5">
					<CircleInfoIcon size={13} className="shrink-0 text-muted-foreground" />
					<span className={cn(LABEL, "text-muted-foreground")}>Capture changes here</span>
					<span className="shrink-0 text-muted-foreground text-xs">
						spans below come from {row.serviceName} — it records {CAPTURES_LABEL[row.captures]}
					</span>
					<span aria-hidden className="h-px grow bg-border" />
				</div>
			</Row>
		)
	}

	return (
		<div className="flex items-start gap-3 rounded-md border border-border bg-card px-4 py-3">
			<CircleInfoIcon size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
			<div className="flex min-w-0 grow flex-col gap-1">
				<p className="font-medium text-[13px] text-foreground">
					Message content isn't captured for {row.anyCaptured ? "most of " : ""}this session
				</p>
				<p className="text-muted-foreground text-xs leading-relaxed">
					Prompts, replies and tool payloads are opt-in — the spans carry timing, models, tokens and
					tool names, but no text. The structure below is complete; only the words are missing.
				</p>
			</div>
		</div>
	)
}

function DividerBlock({
	row,
	timeZone,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "divider" }> }) {
	if (row.dividerKind === "compaction") {
		return (
			<Row
				time={row.startMs === undefined ? undefined : clockOf(row.startMs, timeZone)}
				depth={row.depth}
				timePadding="pt-1"
				className="py-4"
				flush
			>
				<div className="flex items-center gap-2.5">
					<CompactLinesIcon size={14} className="shrink-0 text-chart-4" />
					<span className={cn(LABEL, "text-chart-4")}>Context compacted</span>
					<span className="shrink-0 text-muted-foreground text-xs">
						the agent replaced its history with a summary — earlier messages above are still shown,
						but the model no longer had them
					</span>
					<span aria-hidden className="h-px grow bg-chart-4/30" />
				</div>
			</Row>
		)
	}

	// Truncation drops the END of the session. Never a synthetic conclusion: the
	// divider says the reading stops here, not that the agent did.
	return (
		<div className="mt-8 flex flex-col items-center gap-3 border-input border-t border-dashed pt-6 pb-2">
			<div className="flex items-center gap-2">
				<AlertWarningIcon size={14} className="text-severity-warn" />
				<span className={cn(LABEL, "text-severity-warn")}>Session truncated</span>
			</div>
			<p className="text-center text-[13px] text-muted-foreground">
				This session has more spans than one response carries. Later activity is not shown, and this
				is not where the session ended.
			</p>
			<p className="text-muted-foreground text-xs">
				Narrow the time range to see the rest.
			</p>
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Shared bits                                                                */
/* -------------------------------------------------------------------------- */

function InlineNote({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				"flex items-start gap-2.5 rounded-md border border-input border-dashed bg-muted/20 px-3 py-2",
				className,
			)}
		>
			<CircleQuestionIcon size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
			<p className="min-w-0 text-muted-foreground text-xs leading-relaxed">{children}</p>
		</div>
	)
}

function OpenInTraces({ span, onOpenTraceView }: { span: AiSessionSpan; onOpenTraceView: () => void }) {
	return (
		<span className="flex shrink-0 items-center gap-1.5">
			<Button
				variant="outline"
				size="sm"
				className="h-5 px-1.5 text-[11px]"
				onClick={(event) => {
					event.stopPropagation()
					onOpenTraceView()
				}}
			>
				Waterfall
			</Button>
			<Button
				variant="outline"
				size="sm"
				className="h-5 gap-1 px-1.5 text-[11px]"
				render={
					<Link
						to="/traces/$traceId"
						params={{ traceId: span.traceId }}
						search={{ t: span.timestamp, spanId: span.spanId }}
					/>
				}
			>
				Open in Traces
				<ExternalLinkIcon size={10} />
			</Button>
		</span>
	)
}

/** `claude-opus-5 · 6.4K → 512 tok · $0.11 · ttft 780ms · stop tool_use` — every
 *  part omitted where the span did not report it. */
function callMetaLine(span: AiSessionSpan): string {
	const parts: string[] = []
	const model = spanModel(span)
	if (model !== undefined) parts.push(model)

	const buckets = spanTokenBuckets(span)
	if (buckets !== undefined && buckets.total > 0) {
		const completion = buckets.output + buckets.reasoning
		parts.push(`${formatNumber(buckets.total - completion)} → ${formatNumber(completion)} tok`)
	}
	const cost = span.genAi.usageCost
	if (cost !== undefined) parts.push(formatCost(cost))
	const ttftMs = spanTtftMs(span)
	if (ttftMs !== undefined) parts.push(`ttft ${formatDuration(ttftMs)}`)
	const finish = span.genAi.responseFinishReasons
	if (finish !== undefined && finish.length > 0) parts.push(`stop ${finish.join(", ")}`)
	return parts.join(" · ")
}

/** The structure row's second half: what the span reports about itself, with
 *  the absences named rather than left blank. */
function structureMeta(span: AiSessionSpan, category: string): string {
	if (category === "tool") {
		return `· ${span.serviceName} · payloads not captured`
	}
	if (category === "agent") {
		return `· trace ${span.traceId.slice(0, 8)}`
	}
	const meta = callMetaLine(span)
	// The model already leads the label; the rest of the call's facts follow.
	const model = spanModel(span)
	const rest = model === undefined ? meta : meta.slice(model.length).replace(/^ · /, "")
	return rest === "" ? "" : `· ${rest}`
}

const CLOCK_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

/** `14:21:58` in the reader's chosen timezone. Formatters are cached: a long
 *  session renders thousands of these. */
function clockOf(epochMs: number, timeZone: string): string {
	let formatter = CLOCK_FORMATTERS.get(timeZone)
	if (formatter === undefined) {
		formatter = new Intl.DateTimeFormat("en-GB", {
			timeZone,
			hour12: false,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		})
		CLOCK_FORMATTERS.set(timeZone, formatter)
	}
	return formatter.format(epochMs)
}

function firstLine(text: string): string {
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim()
		if (line !== "") return line
	}
	return ""
}
