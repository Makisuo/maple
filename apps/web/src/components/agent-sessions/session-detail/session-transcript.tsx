import { useDeferredValue, useEffect, useMemo, useRef, type ReactNode } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"

import type { AiSessionSpan } from "@maple/domain/http"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
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
	DotsIcon,
	FaceRobotIcon,
	GearIcon,
	PixelSparkleIcon,
	UserIcon,
	type IconComponent,
} from "@/components/icons"
import { usePageScrollMargin } from "@/hooks/use-page-scroll-margin"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { callMetaLine, callMetaParts } from "@/lib/agent-sessions/session-summary"
import { spanModel, type SessionTurn } from "@/lib/agent-sessions/session-turns"
import {
	buildTranscript,
	type CaptureCoverage,
	type TranscriptPayload,
	type TranscriptRow,
} from "@/lib/agent-sessions/session-transcript"
import type { SessionToolResults } from "@/lib/agent-sessions/span-detail"
import { formatClockInTimezone } from "@/lib/timezone-format"
import { ClampedText, firstLine } from "./clamped-text"
import { disclosed, MessageBody, useJsonPayload, useMessageBody, ViewSwitch } from "./payload-view"
import { Pill } from "./pill"
import { ToolIo, ToolIoSummary } from "./tool-io"

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
/** Past this the prose column is narrower than the gutters framing it, and a
 *  deeper lane says nothing the lane header did not. Matches the waterfall. */
const MAX_INDENT_DEPTH = 6

/** A raw attribute value in a pill: upper-casing a wire string reads as shouting. */
const WIRE_PILL = "font-mono text-[11px] normal-case tracking-normal"

/** Starting guesses only — `measureElement` replaces each on mount. */
const ROW_ESTIMATE = {
	turn: 38,
	"empty-turn": 30,
	user: 92,
	system: 42,
	assistant: 100,
	prompt: 130,
	thinking: 42,
	tool: 180,
	"lane-open": 44,
	"lane-close": 34,
	parallel: 34,
	"parallel-turns": 34,
	structure: 30,
	note: 86,
	divider: 60,
} satisfies Record<TranscriptRow["kind"], number>

export function SessionTranscript({
	turns,
	toolResults,
	query,
	showThinking,
	showPayloads,
	truncated,
	collapsedTurns,
	onToggleTurn,
	openRows,
	onToggleRow,
	selectedSpanId,
	onSelectSpan,
}: {
	turns: readonly SessionTurn[]
	/** The session's captured tool results by call id (`sessionToolResults`). */
	toolResults: SessionToolResults
	query: string
	/** The toolbar's "Show thinking" chip. */
	showThinking: boolean
	/** The toolbar's "Expand tool payloads" chip: arguments and results open by default. */
	showPayloads: boolean
	/** The response dropped the END of the session. */
	truncated: boolean
	collapsedTurns: ReadonlySet<string>
	onToggleTurn: (turnId: string) => void
	/** Rows whose disclosure the reader has flipped away from its default — held
	 *  outside the list because virtualization unmounts a row that scrolls out. */
	openRows: ReadonlySet<string>
	onToggleRow: (key: string) => void
	selectedSpanId: string | undefined
	onSelectSpan: (spanId: string | undefined) => void
}) {
	const { ref: listRef, getScrollElement, scrollMargin } = usePageScrollMargin()
	const { effectiveTimezone } = useTimezonePreference()

	// The build parses every captured payload the query has to search, so it
	// trails the input by a frame rather than running on the keystroke.
	const deferredQuery = useDeferredValue(query)
	const rows = useMemo(
		() =>
			buildTranscript({
				turns,
				toolResults,
				query: deferredQuery,
				showThinking,
				truncated,
				collapsedTurns,
			}),
		[turns, toolResults, deferredQuery, showThinking, truncated, collapsedTurns],
	)

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement,
		// Every row's height is its content's, so the estimate only has to be in
		// the right order of magnitude before the measurement lands.
		estimateSize: (index) => ROW_ESTIMATE[rows[index]!.kind],
		getItemKey: (index) => rows[index]!.key,
		overscan: 12,
		scrollMargin,
		// Measured rows can resize while React is already rendering (a fixture or
		// data swap re-fills mounted rows); without this the ResizeObserver path
		// calls flushSync mid-lifecycle and React logs an error for every batch.
		useAnimationFrameWithResizeObserver: true,
	})

	// A pasted `?span=` link lands on the block it names. Once, on mount — after
	// that the URL follows the reader rather than leading them. Not before the
	// scroller exists, though: the list element attaches in a layout effect, so
	// on the render that mounts this view `scrollToIndex` has nothing to scroll.
	const didInitialScroll = useRef(false)
	useEffect(() => {
		if (didInitialScroll.current || selectedSpanId === undefined) return
		if (getScrollElement() === null) return
		didInitialScroll.current = true
		const index = rows.findIndex((row) => "span" in row && row.span.spanId === selectedSpanId)
		if (index !== -1) virtualizer.scrollToIndex(index, { align: "center" })
	}, [selectedSpanId, rows, virtualizer, getScrollElement])

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
		// The padding sits OUTSIDE the measured element: the virtualizer positions
		// rows against this list's own top edge, and padding on it would offset
		// every row by its height.
		<div className="pt-2">
			<div ref={listRef}>
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
									openRows={openRows}
									onToggleRow={onToggleRow}
									selected={"span" in row && row.span.spanId === selectedSpanId}
									onSelectSpan={onSelectSpan}
								/>
							</div>
						)
					})}
				</div>
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
	openRows: ReadonlySet<string>
	onToggleRow: (key: string) => void
	selected: boolean
	onSelectSpan: (spanId: string | undefined) => void
}

function TranscriptBlock(props: BlockProps) {
	const { row } = props
	switch (row.kind) {
		case "turn":
			return <TurnChapter {...props} row={row} />
		case "empty-turn":
			return <EmptyTurnRow row={row} />
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
			return <LaneClose {...props} row={row} />
		case "parallel":
			return <ParallelMarker {...props} row={row} />
		case "parallel-turns":
			return <ParallelTurnsMarker {...props} row={row} />
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
			<IndentLanes depth={depth} />
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

/** The nesting hairlines, one lane each — `self-stretch` so they still span the
 *  row inside an `items-center` header like the turn chapter's. */
function IndentLanes({ depth }: { depth: number }) {
	return (
		<>
			{Array.from({ length: Math.min(depth, MAX_INDENT_DEPTH) }, (_, index) => (
				<span key={index} aria-hidden className={cn(INDENT, "self-stretch")}>
					<span className="w-px bg-border" />
				</span>
			))}
		</>
	)
}

/* -------------------------------------------------------------------------- */
/* Turn chapter                                                               */
/* -------------------------------------------------------------------------- */

/** "Turn 3" / "Segment 2" — a trace-anchored turn is the fallback partition,
 *  one turn per trace, so it is a segment of the session rather than an
 *  established exchange with the user. */
function turnOrdinal(turn: SessionTurn): string {
	return `${turn.anchorKind === "trace" ? "Segment" : "Turn"} ${turn.index}`
}

function TurnChapter({
	row,
	timeZone,
	collapsed,
	onToggleTurn,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "turn" }> }) {
	const { turn } = row

	return (
		<h3 className="mt-5 flex items-center border-border border-b pb-2 font-normal text-base">
			<span className={cn(GUTTER, "pt-0")}>{clockOf(turn.startMs, timeZone)}</span>
			<IndentLanes depth={row.depth} />
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
				<span className={cn(LABEL, "text-primary")}>{turnOrdinal(turn).toUpperCase()}</span>
				{/* The label is the first prose line of a captured message, not a
				    verbatim quote, so it is set as text rather than quoted. */}
				<span className="min-w-0 truncate font-medium text-[13px]">
					{turn.label ?? <span className="text-muted-foreground italic">no prompt captured</span>}
				</span>
				{turn.agentName !== undefined && <AgentPill name={turn.agentName} />}
				{turn.failed && <Pill tone="error">Failed</Pill>}
				{/* Shrinkable, unlike its neighbours: the summary joins every tool
				    name in the turn, so it truncates rather than widening the page. */}
				{collapsed && <span className={META}>{summariseTurn(row)}</span>}
				<span className="grow" />
				{/* The AI spans the transcript actually renders, not the turn's raw
				    time slice: that slice carries the app's own HTTP/DB spans too, and
				    a count the page cannot account for is worse than no count. */}
				<span className={cn(META, "shrink-0")}>
					{turn.traceIds.length} trace{turn.traceIds.length === 1 ? "" : "s"} · {row.aiSpanCount}{" "}
					agent spans · {formatDuration(turn.durationMs)}
				</span>
			</button>
		</h3>
	)
}

/** A turn with no agent work at all. Rendered rather than dropped so the
 *  ordinals here line up with the ones Traces and Flow print. */
function EmptyTurnRow({ row }: { row: Extract<TranscriptRow, { kind: "empty-turn" }> }) {
	return (
		<Row depth={row.depth} timePadding="pt-1" className="pt-2">
			<div className="flex items-center gap-2.5 text-muted-foreground">
				<DotsIcon size={13} className="shrink-0" />
				<span className={cn(LABEL, "text-muted-foreground")}>
					{turnOrdinal(row.turn).toUpperCase()}
				</span>
				<span className="min-w-0 truncate text-xs">
					no agent activity — HTTP/DB work only, see Traces
				</span>
				<span aria-hidden className="h-px grow bg-border" />
			</div>
		</Row>
	)
}

/** A collapsed chapter keeps its whole summary on the header row, so a long
 *  session can be skimmed one line per turn. */
function summariseTurn(row: Extract<TranscriptRow, { kind: "turn" }>): string {
	const parts = [`${row.llmCalls} LLM call${row.llmCalls === 1 ? "" : "s"}`]
	if (row.toolNames.length > 0) parts.push(row.toolNames.join(", "))
	return parts.join(" · ")
}

/** Capped and truncating: the name is emitter input, and an unbounded one would
 *  push its header row — and with it the page — into a horizontal scroll. */
function AgentPill({ name }: { name: string }) {
	return (
		<span
			className="flex max-w-56 shrink-0 items-center gap-1.5 rounded-sm bg-primary/12 px-1.5 py-px font-mono text-[11px] text-primary"
			title={name}
		>
			<span aria-hidden className="size-1 shrink-0 rounded-full bg-primary" />
			<span className="min-w-0 truncate">{name}</span>
		</span>
	)
}

/* -------------------------------------------------------------------------- */
/* Message blocks                                                             */
/* -------------------------------------------------------------------------- */

function UserBlock({
	row,
	timeZone,
	openRows,
	onToggleRow,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "user" }> }) {
	const historyKey = `${row.key}:history`
	const showHistory = disclosed(openRows, historyKey, false)
	const rawKey = `${row.key}:raw`
	const raw = disclosed(openRows, rawKey, false)
	const textKey = `${row.key}:text`
	const body = useMessageBody(row.text)

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
							onClick={() => onToggleRow(historyKey)}
							aria-expanded={showHistory}
							className="shrink-0 cursor-pointer text-[11px] text-chart-2 hover:underline"
						>
							{showHistory ? "hide full history" : "show full history"}
						</button>
					)}
					<ViewSwitch
						rendered={body.rendered}
						raw={raw}
						onRawChange={(next) => next !== raw && onToggleRow(rawKey)}
					/>
				</div>
				{/* Clamped like every other long body: a pasted 400-line prompt is one
				    block of a conversation, not the page. "Show full" opens it. */}
				<MessageBody
					text={row.text}
					body={body}
					raw={raw}
					expanded={disclosed(openRows, textKey, false)}
					onToggleExpanded={() => onToggleRow(textKey)}
				/>
				{showHistory && (
					<div className="flex flex-col gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5">
						{/* The history verbatim, not a diff: dropped and truncated
						    messages make a suffix diff unreliable, so what the model was
						    actually sent is shown whole instead of guessed at. */}
						<p className="text-[11px] text-muted-foreground">
							The whole history this call re-sent, as captured.
						</p>
						{row.history.map((message, index) => {
							const key = `${row.key}:history-${index}`
							return (
								<div key={index} className="flex flex-col gap-1">
									<span className={cn(LABEL, "text-muted-foreground")}>{message.role}</span>
									<ClampedText
										text={message.parts
											.map((part) =>
												part.kind === "text" ? part.text : `[${part.kind}]`,
											)
											.join("\n")}
										clampClass="line-clamp-[6]"
										expanded={disclosed(openRows, key, false)}
										onToggleExpanded={() => onToggleRow(key)}
									/>
								</div>
							)
						})}
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
	openRows,
	onToggleRow,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "system" }> }) {
	const open = disclosed(openRows, row.key, false)
	const textKey = `${row.key}:text`
	const rawKey = `${row.key}:raw`
	const raw = disclosed(openRows, rawKey, false)
	const body = useMessageBody(row.text)

	return (
		<Row depth={row.depth} rail="bg-muted-foreground/40" className="pt-3.5">
			<button
				type="button"
				onClick={() => onToggleRow(row.key)}
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
				{/* "all N" only when every call carried it — an emitter that sends the
				    instructions on some calls and not others is a fact about the run. */}
				{row.callCount > 1 && (
					<span className={cn(META, "shrink-0")}>
						{row.callCount >= row.turnCallCount
							? `identical across all ${row.callCount} calls this turn`
							: `identical across ${row.callCount} of ${row.turnCallCount} calls this turn`}
					</span>
				)}
			</button>
			{open && (
				<div className="flex items-start gap-1.5 pb-2 pl-6">
					<div className="min-w-0 grow">
						<MessageBody
							text={row.text}
							body={body}
							raw={raw}
							proseClassName="text-sm"
							expanded={disclosed(openRows, textKey, false)}
							onToggleExpanded={() => onToggleRow(textKey)}
						/>
					</div>
					<ViewSwitch
						rendered={body.rendered}
						raw={raw}
						onRawChange={(next) => next !== raw && onToggleRow(rawKey)}
					/>
					{/* Copies the prompt as captured, not its rendering. */}
					<CopyButton value={row.text} label="system prompt" className="-my-1 shrink-0" />
				</div>
			)}
		</Row>
	)
}

function AssistantBlock({
	row,
	timeZone,
	openRows,
	onToggleRow,
	selected,
	onSelectSpan,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "assistant" }> }) {
	const tone = row.failed ? "text-destructive" : "text-chart-2"
	const Glyph = row.failed ? CircleWarningIcon : PixelSparkleIcon
	// The failure payload some providers put in the status message — often a
	// whole JSON error envelope, so it gets the same JSON treatment as a tool
	// payload. Empty where the call succeeded, and the hook is cheap on "".
	const error = useJsonPayload(row.failed ? row.span.statusMessage : "")
	const body = useMessageBody(row.text ?? "")
	const textKey = `${row.key}:text`
	const rawKey = `${row.key}:raw`
	const raw = disclosed(openRows, rawKey, false)
	const errorRawKey = `${row.key}:error-raw`
	const errorRaw = disclosed(openRows, errorRawKey, false)

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
					aria-pressed={selected}
					className="flex min-w-0 grow cursor-pointer items-center gap-2.5 text-left"
				>
					<Glyph size={13} className={cn("shrink-0", tone)} />
					<span className={cn(LABEL, tone)}>Assistant</span>
					{row.failed && <span className={cn(LABEL, "text-destructive")}>· Failed</span>}
					<span className={META}>{callMetaLine(row.span)}</span>
				</button>
				{row.span.genAi.errorType !== undefined && (
					<Pill tone="error" className={WIRE_PILL}>
						error.type {row.span.genAi.errorType}
					</Pill>
				)}
				{row.text !== undefined && (
					<ViewSwitch
						rendered={body.rendered}
						raw={raw}
						onRawChange={(next) => next !== raw && onToggleRow(rawKey)}
					/>
				)}
			</div>
			{row.text !== undefined && (
				<div className="pt-2.5">
					<MessageBody
						text={row.text}
						body={body}
						raw={raw}
						expanded={disclosed(openRows, textKey, false)}
						onToggleExpanded={() => onToggleRow(textKey)}
					/>
				</div>
			)}
			{row.failed && (
				<div className="flex flex-col gap-1.5 pt-2.5">
					{row.span.statusMessage !== "" && (
						<div className="flex items-start gap-1.5">
							<div className="min-w-0 grow">
								<ClampedText
									text={errorRaw ? row.span.statusMessage : error.formatted}
									html={errorRaw ? undefined : error.highlighted}
									mono
									clampClass="line-clamp-[14]"
									toneClass="text-[13px] text-destructive/90"
									expanded={disclosed(openRows, `${row.key}:error-text`, false)}
									onToggleExpanded={() => onToggleRow(`${row.key}:error-text`)}
								/>
							</div>
							{error.highlighted !== undefined && (
								<ViewSwitch
									rendered="json"
									raw={errorRaw}
									onRawChange={(next) => next !== errorRaw && onToggleRow(errorRawKey)}
									className="self-start"
								/>
							)}
							<CopyButton
								value={errorRaw ? row.span.statusMessage : error.formatted}
								label="error message"
								className="-my-1 shrink-0"
							/>
						</div>
					)}
					{/* Never "the agent gave up": what the span supports is that this
					    call produced nothing. A retry, if there was one, is its own row. */}
					<p className="text-muted-foreground text-xs">No reply was produced by this call.</p>
				</div>
			)}
			{!row.failed && row.text === undefined && (
				<InlineNote className="mt-2.5">
					The reply isn't captured. This emitter recorded the request but not{" "}
					<span className="font-mono">gen_ai.output.messages</span>, so the call's text is gone — it
					did not fail.
				</InlineNote>
			)}
		</Row>
	)
}

/** A captured prompt whose reply the emitter never recorded. */
function PromptBlock({
	row,
	timeZone,
	openRows,
	onToggleRow,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "prompt" }> }) {
	const rawKey = `${row.key}:raw`
	const raw = disclosed(openRows, rawKey, false)
	const textKey = `${row.key}:text`
	const body = useMessageBody(row.text)

	return (
		<Row time={clockOf(row.startMs, timeZone)} depth={row.depth} rail="bg-chart-2" className="pt-3">
			<div className="flex flex-col gap-2.5">
				<div className="flex items-center gap-2.5">
					<PixelSparkleIcon size={13} className="shrink-0 text-chart-2" />
					<span className={cn(LABEL, "text-chart-2")}>Prompt</span>
					<span className={META}>{callMetaLine(row.span)}</span>
					<span className="grow" />
					<span className={cn(META, "shrink-0")}>{row.span.serviceName}</span>
					<ViewSwitch
						rendered={body.rendered}
						raw={raw}
						onRawChange={(next) => next !== raw && onToggleRow(rawKey)}
					/>
				</div>
				<MessageBody
					text={row.text}
					body={body}
					raw={raw}
					expanded={disclosed(openRows, textKey, false)}
					onToggleExpanded={() => onToggleRow(textKey)}
				/>
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
	openRows,
	onToggleRow,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "thinking" }> }) {
	const open = disclosed(openRows, row.key, false)
	const textKey = `${row.key}:text`
	const reasoningTokens = row.span.genAi.usageReasoningOutputTokens

	return (
		<Row time={clockOf(row.startMs, timeZone)} depth={row.depth} rail="bg-chart-5" className="pt-3.5">
			<button
				type="button"
				onClick={() => onToggleRow(row.key)}
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
					<span className="shrink-0 text-muted-foreground text-xs">redacted by the provider</span>
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
					<ClampedText
						text={row.text}
						expanded={disclosed(openRows, textKey, false)}
						onToggleExpanded={() => onToggleRow(textKey)}
					/>
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
	openRows,
	onToggleRow,
	selected,
	onSelectSpan,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "tool" }> }) {
	const payloadsKey = `${row.key}:payloads`
	const open = disclosed(openRows, payloadsKey, showPayloads)
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
				<div className="flex h-9 items-center gap-2.5 px-3">
					<button
						type="button"
						onClick={() => onSelectSpan(selected ? undefined : row.span.spanId)}
						aria-pressed={selected}
						className="flex min-w-0 grow cursor-pointer items-center gap-2.5 text-left"
					>
						<GearIcon size={13} className={cn("shrink-0", tone)} />
						<span className={cn(LABEL, tone)}>Tool</span>
						<span
							className="min-w-0 truncate font-medium font-mono text-foreground text-xs"
							title={row.toolName ?? row.span.spanName}
						>
							{row.toolName ?? row.span.spanName}
						</span>
						<span className={cn(META, "shrink-0")}>
							· {row.span.serviceName}
							{!row.fromMessageOnly && ` · ${formatDuration(row.span.durationMs)}`}
						</span>
						{/* Sizes in gutter order while the pair is shut, so the reader knows
						    what opening it costs before they pay for it. */}
						{!open && <ToolIoSummary args={row.args} result={row.result} />}
					</button>
					{row.failed && row.span.genAi.errorType !== undefined && (
						<Pill tone="error" className={WIRE_PILL}>
							error.type {row.span.genAi.errorType}
						</Pill>
					)}
					{!row.failed && row.callId !== undefined && (
						<span className={cn(META, "shrink-0")}>{row.callId}</span>
					)}
					{/* The one control that opens the pair, in the header where the reader
					    already is — not a footer they have to scroll the payloads to reach. */}
					<button
						type="button"
						onClick={() => onToggleRow(payloadsKey)}
						aria-expanded={open}
						aria-label={open ? "Collapse payloads" : "Expand payloads"}
						className="-mr-1 shrink-0 cursor-pointer p-1 text-muted-foreground hover:text-foreground"
					>
						{open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
					</button>
				</div>

				{open && (
					<ToolIo
						args={row.args}
						result={row.result}
						failed={row.failed}
						resultMeta={row.failed ? `span status ${row.span.statusCode}` : undefined}
						missingResultNote={
							row.fromMessageOnly
								? "not captured — this call is known only from the message that made it. Whether it ran is unknown."
								: "not captured — the span carries no result attribute and no later message echoes this call id. Whether it succeeded is unknown."
						}
						keyPrefix={row.key}
						openRows={openRows}
						onToggleRow={onToggleRow}
					/>
				)}
			</div>
		</Row>
	)
}

function PayloadSection({
	label,
	payload,
	meta,
	tone,
	bordered = true,
	openRows,
	onToggleRow,
	textKey,
}: {
	label: string
	payload: TranscriptPayload
	meta?: string
	tone?: string
	bordered?: boolean
	openRows: ReadonlySet<string>
	onToggleRow: (key: string) => void
	textKey: string
}) {
	const { formatted, highlighted } = useJsonPayload(payload.text)
	const rawKey = `${textKey}:raw`
	const raw = disclosed(openRows, rawKey, false)

	return (
		<div className={cn("flex flex-col gap-2 px-3 pt-2.5 pb-3", bordered && "border-border/60 border-t")}>
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-[0.1em]">
					{label}
				</span>
				<span className="font-mono text-[10px] text-muted-foreground">
					{[
						meta,
						formatBytes(payload.byteLength),
						payload.lineCount > 1 && `${payload.lineCount} lines`,
					]
						.filter((part): part is string => typeof part === "string")
						.join(" · ")}
				</span>
				{/* Emitter truncation, not the view's clamping — there is no "show
				    full" that can recover what was never recorded. */}
				{payload.truncatedByEmitter && (
					<Pill tone="warn" className="rounded-sm font-mono normal-case tracking-normal">
						truncated by the emitter
					</Pill>
				)}
				{/* Copies what is displayed: the pretty-printed JSON, or the raw text.
				    The switch only appears where the two differ. */}
				{payload.text !== "" && (
					<span className="-my-1 ml-auto flex items-center">
						{highlighted !== undefined && (
							<ViewSwitch
								rendered="json"
								raw={raw}
								onRawChange={(next) => next !== raw && onToggleRow(rawKey)}
								className="mr-1"
							/>
						)}
						<CopyButton value={raw ? payload.text : formatted} label={label.toLowerCase()} />
					</span>
				)}
			</div>
			{/* An emitter that recorded the truncation but kept no prefix leaves
			    nothing to show; an empty card would read as an empty payload. */}
			{payload.text !== "" && (
				<ClampedText
					text={raw ? payload.text : formatted}
					html={raw ? undefined : highlighted}
					mono
					clampClass="line-clamp-[14]"
					toneClass={tone}
					expanded={disclosed(openRows, textKey, false)}
					onToggleExpanded={() => onToggleRow(textKey)}
				/>
			)}
			{payload.truncatedByEmitter && (
				<p className="text-[11px] text-muted-foreground italic">
					Cut off here by the instrumentation, not by Maple — the tail was never recorded.
				</p>
			)}
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Lanes, markers, dividers                                                   */
/* -------------------------------------------------------------------------- */

function LaneOpen({
	row,
	timeZone,
	showPayloads,
	openRows,
	onToggleRow,
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
				{/* Both carry agent names, which are emitter input: capped and
				    truncating so a long one cannot widen the page. */}
				<span
					className="max-w-56 truncate font-medium font-mono text-foreground text-xs"
					title={row.agentName}
				>
					{row.agentName}
				</span>
				<span className={META}>
					{row.laneKind === "subagent" && row.parentAgentName !== undefined
						? `· invoked by ${row.parentAgentName}`
						: `· trace ${row.span.traceId.slice(0, 8)}`}{" "}
					· {row.spanCount} spans · {formatDuration(row.span.durationMs)}
				</span>
				<span aria-hidden className="h-px grow bg-border" />
			</div>
			{/* The handoff's own payload: the `execute_tool task` span this block
			    swallowed is where the task prompt lives, and losing it would leave
			    the sub-agent's work with no record of what was asked for. Behind the
			    same chip as a tool card's payloads — it is one. */}
			{showPayloads && row.args !== undefined && (
				<div className="overflow-hidden rounded-md border border-border bg-card">
					<PayloadSection
						label="Task prompt"
						payload={row.args}
						bordered={false}
						openRows={openRows}
						onToggleRow={onToggleRow}
						textKey={`${row.key}:args-text`}
					/>
				</div>
			)}
		</Row>
	)
}

function LaneClose({
	row,
	showPayloads,
	openRows,
	onToggleRow,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "lane-close" }> }) {
	return (
		<Row depth={row.depth} className="pt-2">
			<div className="flex items-center gap-2.5 py-1">
				<CornerDownLeftIcon size={12} className="shrink-0 text-muted-foreground" />
				<span className="min-w-0 truncate text-muted-foreground text-xs">
					{row.agentName}
					{row.parentAgentName === undefined
						? " finished"
						: ` returned to ${row.parentAgentName}`}{" "}
					· {formatDuration(row.durationMs)} · {row.llmCalls} LLM call
					{row.llmCalls === 1 ? "" : "s"} · {row.toolCalls} tool call
					{row.toolCalls === 1 ? "" : "s"}
				</span>
				<span aria-hidden className="h-px grow bg-border" />
			</div>
			{/* What the sub-agent handed back, read off the delegating tool call's
			    result — the only place the answer is recorded. */}
			{showPayloads && row.result !== undefined && (
				<div className="overflow-hidden rounded-md border border-border bg-card">
					<PayloadSection
						label="Returned"
						payload={row.result}
						bordered={false}
						openRows={openRows}
						onToggleRow={onToggleRow}
						textKey={`${row.key}:result-text`}
					/>
				</div>
			)}
		</Row>
	)
}

/**
 * The fork marker both parallel kinds share: one rule across the column, in the
 * same shape as the page's other structural lines. WHAT forked is already on
 * the rows right below it — all the marker has to say is that they did not run
 * in sequence, and when they were open together.
 */
function ParallelRule({ label, range }: { label: string; range: string }) {
	return (
		<div className="flex items-center gap-2.5 py-1.5">
			<BranchForkIcon size={13} className="shrink-0 text-primary" />
			<span className={cn(LABEL, "text-primary")}>{label}</span>
			<span className={cn(META, "shrink-0")}>{range}</span>
			<span aria-hidden className="h-px grow bg-primary/25" />
		</div>
	)
}

/** Only a window every member shared is reported as an overlap. A chain of
 *  pairwise overlaps has none, and the marker then reports the run's extent
 *  instead of inventing one. */
function overlapWindow(
	row: {
		startMs: number
		endMs: number
		overlapStartMs: number | undefined
		overlapEndMs: number | undefined
	},
	timeZone: string,
): string {
	return row.overlapStartMs !== undefined && row.overlapEndMs !== undefined
		? `overlap ${clockOf(row.overlapStartMs, timeZone)} → ${clockOf(row.overlapEndMs, timeZone)}`
		: `interleaved ${clockOf(row.startMs, timeZone)} → ${clockOf(row.endMs, timeZone)}`
}

/**
 * Where a thread forked. Each lane below still reads whole and in order — the
 * marker is what stops "db-lane, then trace-lane" from reading as a sequence.
 */
function ParallelMarker({
	row,
	timeZone,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "parallel" }> }) {
	return (
		<Row
			time={clockOf(row.startMs, timeZone)}
			depth={row.depth}
			timePadding="pt-2.5"
			className="pt-4"
			flush
		>
			<ParallelRule
				label={`${row.lanes.length} lanes in parallel`}
				range={overlapWindow(row, timeZone)}
			/>
		</Row>
	)
}

/**
 * Where two chapters ran at once — the lane marker one level up.
 *
 * A Maple fan-out gives each sub-agent its own conversation id, and a run
 * dispatched over a queue roots its own trace, so either way the turn partition
 * splits the fan-out into sibling chapters. They still read whole and in order;
 * the marker is what stops "TURN 3, then TURN 4" from reading as a sequence the
 * timestamps deny — and the member turns render indented one lane under it, so
 * the fork is visible even from the middle of a long chapter.
 */
function ParallelTurnsMarker({
	row,
	timeZone,
}: BlockProps & { row: Extract<TranscriptRow, { kind: "parallel-turns" }> }) {
	return (
		<Row
			time={clockOf(row.startMs, timeZone)}
			depth={row.depth}
			timePadding="pt-2.5"
			className="pt-4"
			flush
		>
			<ParallelRule
				label={`${row.turns.length} turns in parallel`}
				range={overlapWindow(row, timeZone)}
			/>
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
			<div className="flex items-center gap-2.5">
				<button
					type="button"
					onClick={() => onSelectSpan(selected ? undefined : row.span.spanId)}
					aria-pressed={selected}
					className={cn(
						"flex min-w-0 grow cursor-pointer items-center gap-2.5 rounded-sm py-1 text-left hover:bg-accent/30",
						selected && "bg-primary/6",
					)}
				>
					<Glyph size={13} className={cn("shrink-0", tone)} />
					<span
						className="min-w-0 truncate font-medium font-mono text-foreground text-xs"
						title={row.label}
					>
						{row.label}
					</span>
					<span className={META}>{structureMeta(row.span, category)}</span>
					<span className="grow" />
					<span className={cn(META, "shrink-0")}>{formatDuration(row.span.durationMs)}</span>
				</button>
			</div>
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
					<span className="min-w-0 text-muted-foreground text-xs">
						spans below come from {row.serviceName} — it records {CAPTURES_LABEL[row.captures]}
					</span>
					<span aria-hidden className="h-px grow bg-border" />
				</div>
			</Row>
		)
	}

	// The same absence, said at the scope it was measured at: a session-wide
	// banner must not read as a claim about one turn, or the other way round.
	const scope = row.scope === "session" ? `${row.anyCaptured ? "most of " : ""}this session` : "this turn"

	return (
		<div className="flex items-start gap-3 rounded-md border border-border bg-card px-4 py-3">
			<CircleInfoIcon size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
			<div className="flex min-w-0 grow flex-col gap-1">
				<p className="font-medium text-[13px] text-foreground">
					Message content isn't captured for {scope}
				</p>
				<p className="text-muted-foreground text-xs leading-relaxed">
					Prompts, replies and tool payloads are opt-in — the spans carry timing, models, tokens and
					tool names, but no text. The structure below is complete; only the words are missing.
				</p>
			</div>
		</div>
	)
}

function DividerBlock({ row, timeZone }: BlockProps & { row: Extract<TranscriptRow, { kind: "divider" }> }) {
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
					<span className="min-w-0 text-muted-foreground text-xs">
						the agent replaced its history with a summary — earlier messages above are still
						shown, but the model no longer had them
					</span>
					<span aria-hidden className="h-px grow bg-chart-4/30" />
				</div>
			</Row>
		)
	}

	// Truncation drops the END of the session. Never a synthetic conclusion: the
	// divider says the reading stops here, not that the agent did. The wording
	// matches the page's own banner, so the two read as one fact stated twice
	// rather than as two different problems.
	return (
		<div className="mt-8 flex flex-col items-center gap-3 border-input border-t border-dashed pt-6 pb-2">
			<div className="flex items-center gap-2">
				<AlertWarningIcon size={14} className="text-severity-warn" />
				<span className={cn(LABEL, "text-severity-warn")}>Session truncated</span>
			</div>
			<p className="text-center text-[13px] text-muted-foreground">
				This session has more spans than one response carries — later activity is not shown, and this
				is not where the session ended.
			</p>
			<p className="text-muted-foreground text-xs">Narrow the time range to see the rest.</p>
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

/** The structure row's second half: what the span reports about itself, with
 *  the absences named rather than left blank. */
function structureMeta(span: AiSessionSpan, category: string): string {
	if (category === "tool") return `· ${span.serviceName} · payloads not captured`
	if (category === "agent") return `· trace ${span.traceId.slice(0, 8)}`
	// The model already leads the label; the rest of the call's facts follow, so
	// the parts are taken as parts rather than sliced back out of a joined line.
	const parts = callMetaParts(span)
	const rest = spanModel(span) === undefined ? parts : parts.slice(1)
	return rest.length === 0 ? "" : `· ${rest.join(" · ")}`
}

/** `14:21:58` in the reader's chosen timezone. */
function clockOf(epochMs: number, timeZone: string): string {
	return formatClockInTimezone(epochMs, { timeZone })
}
