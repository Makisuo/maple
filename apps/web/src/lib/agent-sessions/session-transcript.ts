// The session read as a conversation: turns, threads, messages, tool calls.
//
// `SessionTurn.spans` is a TIME SLICE — every span that started inside the
// turn, whatever trace or agent it belonged to. Rendering it in that order
// interleaves concurrent branches into nonsense ("planner said X", "db-lane
// said Y", "planner said Z"), so this module re-derives structure from
// parentage instead and keeps each agent's thread contiguous, marking the
// places where two threads genuinely overlapped in time.
//
// Everything the transcript claims is read from a span. Nothing is inferred:
// a tool call with no captured result says the result is missing rather than
// implying success, a call with no captured message falls back to its
// structure, and a truncated session ends on a divider rather than on what
// happens to be the last row.
//
// The output is a FLAT row list, the same shape the waterfall virtualizes:
// nesting lives in `depth` and in explicit open/close rows, because a tree of
// components cannot be windowed and a thousand-block session has to stay
// scrollable.

import type { AiSessionSpan } from "@maple/domain/http"

import {
	classifyAiSpan,
	isLlmCall,
	spanEndMs,
	spanFailed,
	spanModel,
	spanStartMs,
	type SessionTurn,
} from "./session-turns"
import { spanMessages, type SpanMessage, type SpanMessagePart } from "./span-detail"

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

/** Why a lane exists, which is also how its header reads. */
export type LaneKind = "lane" | "subagent"

/** A note the transcript makes about itself — never about the agent's work. */
export type TranscriptNoteKind =
	/** No message content anywhere in this session (or in this turn). */
	| "capture-off"
	/** The emitting service changed and so did what it records. */
	| "capture-boundary"

export type TranscriptDividerKind = "compaction" | "truncated"

/** Which halves of a call an emitter records. Mixed sessions have several. */
export type CaptureCoverage = "both" | "input" | "output" | "none"

/** One lane the reader can be sent to, for a parallel marker's jump link. */
export interface TranscriptLaneRef {
	readonly key: string
	readonly agentName: string
}

/** The payload of a tool call or its result, with what the emitter did to it. */
export interface TranscriptPayload {
	readonly text: string
	readonly byteLength: number
	readonly lineCount: number
	/**
	 * The emitter cut this payload off before it ever reached Maple — either a
	 * `{ truncated: true, prefix }` envelope or a trailing `…[truncated]`
	 * marker. The prefix is real text and is shown; what follows it was never
	 * recorded, so the transcript says so instead of clamping silently.
	 */
	readonly truncatedByEmitter: boolean
}

interface RowBase {
	readonly key: string
	/** How many lanes deep: 0 is the turn's main thread. */
	readonly depth: number
}

interface SpanRowBase extends RowBase {
	readonly span: AiSessionSpan
	readonly startMs: number
}

export type TranscriptRow =
	| (RowBase & {
			readonly kind: "turn"
			readonly turn: SessionTurn
			readonly startMs: number
			readonly llmCalls: number
			readonly toolCalls: number
			/** Rows the turn contributes when open — the collapsed header's count. */
			readonly blockCount: number
			readonly toolNames: readonly string[]
	  })
	| (SpanRowBase & {
			readonly kind: "user"
			readonly text: string
			/** Messages re-sent ahead of this one in the same captured history. */
			readonly earlierCount: number
			/** The whole captured history, behind the "show full history" control. */
			readonly history: readonly SpanMessage[]
	  })
	| (SpanRowBase & {
			readonly kind: "system"
			readonly text: string
			/** Calls in this turn that re-sent this exact text. */
			readonly callCount: number
	  })
	| (SpanRowBase & {
			readonly kind: "assistant"
			/** Absent when the call failed, or captured no output text. */
			readonly text: string | undefined
			readonly failed: boolean
	  })
	/** A captured prompt whose reply the emitter did not record. */
	| (SpanRowBase & { readonly kind: "prompt"; readonly text: string })
	| (SpanRowBase & {
			readonly kind: "thinking"
			readonly text: string | undefined
			readonly redacted: boolean
	  })
	| (SpanRowBase & {
			readonly kind: "tool"
			readonly toolName: string | undefined
			readonly callId: string | undefined
			readonly args: TranscriptPayload | undefined
			readonly result: TranscriptPayload | undefined
			readonly failed: boolean
			/** No span carries this call — it is known only from an output message,
			 *  so it has no duration of its own. */
			readonly fromMessageOnly: boolean
	  })
	| (SpanRowBase & {
			readonly kind: "lane-open"
			readonly laneKind: LaneKind
			readonly agentName: string
			/** The agent that invoked it, for a subagent's header. */
			readonly parentAgentName: string | undefined
			readonly spanCount: number
			readonly parallelWith: readonly TranscriptLaneRef[]
	  })
	| (RowBase & {
			readonly kind: "lane-close"
			readonly laneKind: LaneKind
			readonly agentName: string
			readonly parentAgentName: string | undefined
			readonly durationMs: number
			readonly llmCalls: number
			readonly toolCalls: number
	  })
	| (RowBase & {
			readonly kind: "parallel"
			readonly forkedBy: string | undefined
			readonly startMs: number
			readonly endMs: number
			readonly lanes: readonly TranscriptLaneRef[]
	  })
	/** A model call, or a tool call, that captured no content at all. */
	| (SpanRowBase & {
			readonly kind: "structure"
			/** "chat gpt-5", "tool run_sql", "agent db-lane". */
			readonly label: string
			readonly failed: boolean
	  })
	| (RowBase & {
			readonly kind: "note"
			readonly noteKind: TranscriptNoteKind
			/** The service whose capture differs, on a boundary note. */
			readonly serviceName: string | undefined
			/** What that service records, on a boundary note. */
			readonly captures: CaptureCoverage
			/** Whether ANY call in scope captured content, on a capture-off note. */
			readonly anyCaptured: boolean
	  })
	| (RowBase & {
			readonly kind: "divider"
			readonly dividerKind: TranscriptDividerKind
			readonly startMs: number | undefined
	  })

export interface TranscriptInput {
	readonly turns: readonly SessionTurn[]
	/** Session-wide results by tool call id (`sessionToolResults`). */
	readonly toolResults: ReadonlyMap<string, string>
	/** The toolbar's free-text filter. */
	readonly query: string
	/** The toolbar's "Thinking" chip. */
	readonly showThinking: boolean
	/** `GetAiSessionSpansResponse.truncated` — the END of the session is missing. */
	readonly truncated: boolean
	readonly collapsedTurns: ReadonlySet<string>
}

/**
 * Below this share of captured model calls, the transcript leads with one
 * session-level note instead of nagging turn by turn. Above it, capture is the
 * norm here and the exceptions are what deserve a note.
 */
const CAPTURE_BANNER_THRESHOLD = 0.5

export function buildTranscript(input: TranscriptInput): readonly TranscriptRow[] {
	const rows: TranscriptRow[] = []
	const turnRows = input.turns.map((turn) => buildTurn(turn, input))

	// Capture coverage is a fact about the session, so it is counted over every
	// turn before the first row is emitted.
	const llmSpans = turnRows.flatMap((entry) => entry.llmSpans)
	const capturedCalls = llmSpans.filter(hasCapturedContent).length
	const bannerUp =
		llmSpans.length > 0 && capturedCalls / llmSpans.length < CAPTURE_BANNER_THRESHOLD
	if (bannerUp) {
		rows.push({
			kind: "note",
			key: "note:session-capture",
			depth: 0,
			noteKind: "capture-off",
			serviceName: undefined,
			captures: "none",
			anyCaptured: capturedCalls > 0,
		})
	}

	for (const entry of turnRows) {
		// The fallback turn partition is one turn per trace, so a session of pure
		// HTTP/DB work still produces turns. With no AI span in it a turn has
		// nothing a transcript can say, and its header would be the only row.
		if (entry.aiSpanCount === 0) continue
		const collapsed = input.collapsedTurns.has(entry.turn.id)
		const body = collapsed ? [] : entry.rows
		// A turn whose every block was filtered out drops off the page entirely —
		// a header over nothing is worse than no header.
		if (input.query.trim() !== "" && body.length === 0 && !collapsed) continue
		rows.push(entry.header)
		// Per-turn only where the session-level banner is not already up.
		if (!bannerUp && entry.llmSpans.length > 0 && entry.llmSpans.every((s) => !hasCapturedContent(s))) {
			rows.push({
				kind: "note",
				key: `note:${entry.turn.id}`,
				depth: 0,
				noteKind: "capture-off",
				serviceName: undefined,
				captures: "none",
				anyCaptured: false,
			})
		}
		rows.push(...body)
	}

	if (rows.length === 0) return rows

	// Truncation drops the END of the session, so the divider is terminal and
	// unconditional: it says where the reading stops, not where the agent did.
	if (input.truncated) {
		rows.push({
			kind: "divider",
			key: "divider:truncated",
			depth: 0,
			dividerKind: "truncated",
			startMs: undefined,
		})
	}
	return rows
}

/* -------------------------------------------------------------------------- */
/* One turn                                                                   */
/* -------------------------------------------------------------------------- */

interface TurnRows {
	readonly turn: SessionTurn
	readonly header: TranscriptRow
	readonly rows: readonly TranscriptRow[]
	/** The turn's model calls, for the session's capture coverage. */
	readonly llmSpans: readonly AiSessionSpan[]
	readonly aiSpanCount: number
}

function buildTurn(turn: SessionTurn, input: TranscriptInput): TurnRows {
	// Non-AI spans are the app's own HTTP/DB work sharing the agent's traces and
	// have no place in a conversation; a duplicate span id would render its
	// block twice.
	const spans = dedupeById(turn.spans).filter((span) => span.isAiSpan)
	const llmSpans = spans.filter(isLlmCall)
	const toolSpans = spans.filter((span) => classifyAiSpan(span) === "tool")

	// `spanMessages` re-walks the captured JSON on every call and a turn asks for
	// the same span's messages more than once; one cache per turn keeps that to
	// a single parse per span.
	const parsed = new Map<string, readonly SpanMessage[]>()
	const messagesOf = (span: AiSessionSpan): readonly SpanMessage[] => {
		const cached = parsed.get(span.spanId)
		if (cached !== undefined) return cached
		const messages = spanMessages(span)
		parsed.set(span.spanId, messages)
		return messages
	}

	const context: TurnContext = {
		turn,
		input,
		messagesOf,
		// Call ids a tool span already accounts for: an output message's
		// `tool_call` part describes the same call, and rendering both would
		// count one invocation twice.
		coveredCallIds: new Set(
			toolSpans.map((span) => span.genAi.toolCallId).filter((id): id is string => id !== undefined),
		),
		systemCounts: countSystemInstructions(llmSpans, messagesOf),
		emittedSystem: new Set<string>(),
		userEmitted: false,
		lastCapture: undefined,
	}

	const forest = buildForest(spans)
	const body = walkLane(forest.roots, forest.children, {
		context,
		depth: 0,
		agentName: turn.agentName,
		keyPrefix: turn.id,
	})

	const rows = filterRows(body, input.query)
	return {
		turn,
		llmSpans,
		aiSpanCount: spans.length,
		header: {
			kind: "turn",
			key: turn.id,
			depth: 0,
			turn,
			startMs: turn.startMs,
			llmCalls: llmSpans.length,
			toolCalls: toolSpans.length,
			blockCount: rows.length,
			toolNames: distinct(
				toolSpans.map((span) => span.genAi.toolName).filter((n): n is string => n !== undefined),
			),
		},
		rows,
	}
}

interface TurnContext {
	readonly turn: SessionTurn
	readonly input: TranscriptInput
	/** Per-turn cache over `spanMessages` — the captured JSON is parsed once. */
	readonly messagesOf: (span: AiSessionSpan) => readonly SpanMessage[]
	readonly coveredCallIds: ReadonlySet<string>
	readonly systemCounts: ReadonlyMap<string, number>
	/** System text already shown this turn — emitters re-send it every call. */
	readonly emittedSystem: Set<string>
	/** The turn's user message comes from the FIRST captured history only. */
	userEmitted: boolean
	/** `service|coverage` of the last model call, for the capture-boundary note. */
	lastCapture: string | undefined
}

/* -------------------------------------------------------------------------- */
/* Forest                                                                     */
/* -------------------------------------------------------------------------- */

interface SpanForest {
	readonly roots: readonly AiSessionSpan[]
	readonly children: ReadonlyMap<string, readonly AiSessionSpan[]>
}

/**
 * The turn's spans as a forest.
 *
 * `parentSpanId` is intra-trace only, so a turn spanning several traces has one
 * root per trace; roots and siblings are ordered by start time, which is the
 * only ordering the data supports. A span whose parent lives in another turn is
 * promoted to a root rather than dropped.
 */
function buildForest(spans: readonly AiSessionSpan[]): SpanForest {
	const present = new Set(spans.map((span) => span.spanId))
	const children = new Map<string, AiSessionSpan[]>()
	const roots: AiSessionSpan[] = []
	for (const span of spans) {
		if (span.parentSpanId !== "" && present.has(span.parentSpanId)) {
			const siblings = children.get(span.parentSpanId)
			if (siblings === undefined) children.set(span.parentSpanId, [span])
			else siblings.push(span)
		} else {
			roots.push(span)
		}
	}
	const byStart = (a: AiSessionSpan, b: AiSessionSpan) => spanStartMs(a) - spanStartMs(b)
	roots.sort(byStart)
	for (const siblings of children.values()) siblings.sort(byStart)
	return { roots, children }
}

/* -------------------------------------------------------------------------- */
/* Lane walking                                                               */
/* -------------------------------------------------------------------------- */

interface LaneScope {
	readonly context: TurnContext
	readonly depth: number
	/** The agent whose thread this is; a differently-named agent forks a lane. */
	readonly agentName: string | undefined
	readonly keyPrefix: string
}

/** A lane's rows, held whole so overlapping lanes can be marked before either
 *  of them is emitted. */
interface LaneBlock {
	readonly rows: readonly TranscriptRow[]
	readonly ref: TranscriptLaneRef
	readonly startMs: number
	readonly endMs: number
	/** Index in the parent's row list where the lane's first row goes. */
	readonly at: number
}

function walkLane(
	spans: readonly AiSessionSpan[],
	children: ReadonlyMap<string, readonly AiSessionSpan[]>,
	scope: LaneScope,
): readonly TranscriptRow[] {
	const rows: TranscriptRow[] = []
	const lanes: LaneBlock[] = []

	for (const span of spans) {
		// The turn's own anchor is what the chapter header already describes;
		// repeating it as a row would open every turn with a restatement. Only an
		// AGENT anchor, though: a conversation-id partition can anchor a turn on
		// the model call that opened it, and that call's reply is the turn.
		if (span.spanId === scope.context.turn.anchor.spanId && classifyAiSpan(span) === "agent") {
			rows.push(...walkLane(children.get(span.spanId) ?? [], children, scope))
			continue
		}

		const lane = openedLane(span, children, scope)
		if (lane !== undefined) {
			lanes.push({ ...lane, at: rows.length })
			rows.push(...lane.rows)
			continue
		}
		rows.push(...spanRows(span, scope))
		rows.push(...walkLane(children.get(span.spanId) ?? [], children, scope))
	}

	return markParallelLanes(rows, lanes, scope)
}

/**
 * The lane this span opens, if it opens one.
 *
 * A lane is an agent span running under a DIFFERENT agent than the thread it
 * sits in — a handoff, a fan-out branch, or a sub-agent. Comparing against the
 * enclosing thread rather than the immediate parent is deliberate: frameworks
 * put unnamed wrappers (an HTTP client span, an `agent_step`) between the two
 * agents, and reading only the parent would hide the fork.
 *
 * Maple delegates as `execute_tool task` → `invoke_agent`, one span pair for
 * one handoff, so a tool span whose only real work is that invocation is
 * collapsed into the agent block rather than rendered as a tool card above it.
 */
function openedLane(
	span: AiSessionSpan,
	children: ReadonlyMap<string, readonly AiSessionSpan[]>,
	scope: LaneScope,
): Omit<LaneBlock, "at"> | undefined {
	const agentSpan = delegationTarget(span, children, scope.agentName)
	if (agentSpan === undefined) return undefined

	const agentName = agentSpan.genAi.agentName
	if (agentName === undefined) return undefined

	const key = `${scope.keyPrefix}:lane:${agentSpan.spanId}`
	const inner = children.get(agentSpan.spanId) ?? []
	const laneRows = walkLane(inner, children, {
		context: scope.context,
		depth: scope.depth + 1,
		agentName,
		keyPrefix: key,
	})
	const descendants = countDescendants(agentSpan, children)
	// A handoff the agent made by CALLING a tool is a sub-agent it delegated to;
	// an agent span forked directly is a branch of the same run. The distinction
	// is in the data (`execute_tool task` → `invoke_agent`), not in the depth.
	const laneKind: LaneKind = agentSpan.spanId === span.spanId ? "lane" : "subagent"

	return {
		ref: { key, agentName },
		startMs: spanStartMs(span),
		endMs: Math.max(spanEndMs(span), spanEndMs(agentSpan)),
		rows: [
			{
				kind: "lane-open",
				key,
				depth: scope.depth + 1,
				span: agentSpan,
				startMs: spanStartMs(agentSpan),
				laneKind,
				agentName,
				parentAgentName: scope.agentName,
				spanCount: descendants.spans,
				parallelWith: [],
			},
			...laneRows,
			{
				kind: "lane-close",
				key: `${key}:close`,
				depth: scope.depth + 1,
				laneKind,
				agentName,
				parentAgentName: scope.agentName,
				durationMs: agentSpan.durationMs,
				llmCalls: descendants.llmCalls,
				toolCalls: descendants.toolCalls,
			},
		],
	}
}

/** The agent span this span hands off to: itself, or the one delegation-shaped
 *  child a `task`-style tool span exists only to invoke. */
function delegationTarget(
	span: AiSessionSpan,
	children: ReadonlyMap<string, readonly AiSessionSpan[]>,
	enclosingAgent: string | undefined,
): AiSessionSpan | undefined {
	const forks = (candidate: AiSessionSpan): boolean =>
		classifyAiSpan(candidate) === "agent" &&
		candidate.genAi.agentName !== undefined &&
		candidate.genAi.agentName !== enclosingAgent

	if (forks(span)) return span
	if (classifyAiSpan(span) !== "tool") return undefined
	const own = children.get(span.spanId) ?? []
	return own.length === 1 && forks(own[0]!) ? own[0] : undefined
}

function countDescendants(
	span: AiSessionSpan,
	children: ReadonlyMap<string, readonly AiSessionSpan[]>,
): { spans: number; llmCalls: number; toolCalls: number } {
	let spans = 0
	let llmCalls = 0
	let toolCalls = 0
	const stack = [...(children.get(span.spanId) ?? [])]
	while (stack.length > 0) {
		const next = stack.pop()!
		spans++
		if (isLlmCall(next)) llmCalls++
		else if (classifyAiSpan(next) === "tool") toolCalls++
		stack.push(...(children.get(next.spanId) ?? []))
	}
	return { spans, llmCalls, toolCalls }
}

/**
 * Mark lanes of this thread that ran at the same time.
 *
 * Each lane still reads whole and in order; the marker is what stops the reader
 * from taking "db-lane, then trace-lane" as a sequence. Only agent-level lanes
 * qualify — concurrent leaf tool calls are the normal shape of an agent loop
 * and marking them would bury the forks that matter.
 */
function markParallelLanes(
	rows: readonly TranscriptRow[],
	lanes: readonly LaneBlock[],
	scope: LaneScope,
): readonly TranscriptRow[] {
	if (lanes.length < 2) return rows

	const clusters: LaneBlock[][] = []
	for (const lane of lanes) {
		const cluster = clusters.at(-1)
		const previous = cluster?.at(-1)
		// Sorted by position, which is start order, so overlapping with the last
		// member is enough to join the run.
		if (cluster !== undefined && previous !== undefined && lane.startMs < previous.endMs) {
			cluster.push(lane)
		} else {
			clusters.push([lane])
		}
	}

	const out = [...rows]
	const markers: { at: number; row: TranscriptRow }[] = []
	for (const cluster of clusters) {
		if (cluster.length < 2) continue
		const refs = cluster.map((lane) => lane.ref)
		for (const lane of cluster) {
			const index = out.findIndex((row) => row.key === lane.ref.key)
			const row = out[index]
			if (row?.kind !== "lane-open") continue
			out[index] = { ...row, parallelWith: refs.filter((ref) => ref.key !== lane.ref.key) }
		}
		markers.push({
			at: cluster[0]!.at,
			row: {
				kind: "parallel",
				key: `${cluster[0]!.ref.key}:parallel`,
				depth: scope.depth,
				forkedBy: scope.agentName,
				startMs: Math.max(...cluster.map((lane) => lane.startMs)),
				endMs: Math.min(...cluster.map((lane) => lane.endMs)),
				lanes: refs,
			},
		})
	}

	// Back to front, so an earlier insertion never shifts a later index.
	for (const marker of markers.reverse()) out.splice(marker.at, 0, marker.row)
	return out
}

/* -------------------------------------------------------------------------- */
/* One span's rows                                                            */
/* -------------------------------------------------------------------------- */

function spanRows(span: AiSessionSpan, scope: LaneScope): readonly TranscriptRow[] {
	const rows: TranscriptRow[] = []
	const { context, depth } = scope
	const base = { depth, span, startMs: spanStartMs(span) }

	// The agent replaced its history with a summary here — the reason the input
	// history shrinks below, and not an error.
	if (span.genAi.conversationCompacted === true) {
		rows.push({
			kind: "divider",
			key: `${scope.keyPrefix}:${span.spanId}:compacted`,
			depth,
			dividerKind: "compaction",
			startMs: spanStartMs(span),
		})
	}

	const category = classifyAiSpan(span)
	if (category === "tool") {
		rows.push(toolRow(span, scope))
		return rows
	}
	if (!isLlmCall(span)) {
		// An agent or retrieval span that opened no lane still happened; it has no
		// message of its own, so it reads as structure.
		rows.push({
			...base,
			kind: "structure",
			key: rowKey(scope, span),
			label: structureLabel(span, category),
			failed: spanFailed(span),
		})
		return rows
	}

	const messages = context.messagesOf(span)
	rows.push(...systemRows(messages, span, scope))
	const user = userRows(messages, span, scope)
	rows.push(...user)
	rows.push(...captureBoundaryRow(span, messages, scope))
	// The turn's opening prompt is already the user row above; a prompt block
	// here would print the same words twice under two different labels.
	rows.push(...outputRows(messages, span, scope, user.length === 0))
	return rows
}

function rowKey(scope: LaneScope, span: AiSessionSpan, suffix?: string): string {
	return suffix === undefined
		? `${scope.keyPrefix}:${span.spanId}`
		: `${scope.keyPrefix}:${span.spanId}:${suffix}`
}

/* System ------------------------------------------------------------------ */

/** Emitters re-send the system prompt on every call, so it is shown once per
 *  turn per distinct text, with the repeat count instead of the repeats. */
function systemRows(
	messages: readonly SpanMessage[],
	span: AiSessionSpan,
	scope: LaneScope,
): readonly TranscriptRow[] {
	const rows: TranscriptRow[] = []
	for (const message of messages) {
		if (message.role.toLowerCase() !== "system") continue
		const text = textOf(message.parts)
		if (text === "" || scope.context.emittedSystem.has(text)) continue
		scope.context.emittedSystem.add(text)
		rows.push({
			kind: "system",
			key: rowKey(scope, span, `system-${scope.context.emittedSystem.size}`),
			depth: scope.depth,
			span,
			startMs: spanStartMs(span),
			text,
			callCount: scope.context.systemCounts.get(text) ?? 1,
		})
	}
	return rows
}

function countSystemInstructions(
	llmSpans: readonly AiSessionSpan[],
	messagesOf: (span: AiSessionSpan) => readonly SpanMessage[],
): ReadonlyMap<string, number> {
	const counts = new Map<string, number>()
	for (const span of llmSpans) {
		for (const message of messagesOf(span)) {
			if (message.role.toLowerCase() !== "system") continue
			const text = textOf(message.parts)
			if (text === "") continue
			counts.set(text, (counts.get(text) ?? 0) + 1)
		}
	}
	return counts
}

/* User -------------------------------------------------------------------- */

/**
 * The turn's new user input.
 *
 * `gen_ai.input.messages` is the WHOLE history re-sent on every call, so the
 * second call of a turn carries the first call's prompt again. Only the first
 * captured history of the turn is read, and only its last user message: that is
 * what the turn is about. Later histories are deliberately not diffed against
 * it — dropped and truncated messages make a suffix diff unreliable, and a
 * wrong delta is worse than none. What the reader loses is behind the full
 * history the row carries.
 *
 * TODO: `maple_ai.input_messages_dropped` counts whole messages the emitter
 * dropped to fit its attribute budget, which would let this row say "N earlier
 * messages dropped" rather than only "N re-sent". It is unreachable read-side —
 * the constant exists in `packages/domain/src/gen-ai.ts` but has no
 * `AI_GENAI_FIELDS` entry, and the session endpoint drops the raw attribute map
 * server-side, so adding the catalog entry alone may not be enough.
 */
function userRows(
	messages: readonly SpanMessage[],
	span: AiSessionSpan,
	scope: LaneScope,
): readonly TranscriptRow[] {
	if (scope.context.userEmitted) return []
	const history = messages.filter((message) => message.origin === "input")
	if (history.length === 0) return []

	let index = -1
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i]!.role.toLowerCase() === "user") {
			index = i
			break
		}
	}
	if (index === -1) return []
	const text = textOf(history[index]!.parts)
	if (text === "") return []

	scope.context.userEmitted = true
	return [
		{
			kind: "user",
			key: rowKey(scope, span, "user"),
			depth: scope.depth,
			span,
			startMs: spanStartMs(span),
			text,
			earlierCount: index,
			history,
		},
	]
}

/* Output ------------------------------------------------------------------ */

/**
 * What the call produced: its reply, its reasoning, and any tool call no span
 * of its own accounts for — in the order the parts were captured, because a
 * reply written after a thought reads differently from one written before it.
 */
function outputRows(
	messages: readonly SpanMessage[],
	span: AiSessionSpan,
	scope: LaneScope,
	promptAllowed: boolean,
): readonly TranscriptRow[] {
	const rows: TranscriptRow[] = []
	const output = messages.filter((message) => message.origin === "output")
	const failed = spanFailed(span)
	const base = { depth: scope.depth, span, startMs: spanStartMs(span) }
	let partIndex = 0

	for (const message of output) {
		for (const part of message.parts) {
			const key = rowKey(scope, span, `out-${partIndex++}`)
			if (part.kind === "reasoning") {
				if (!scope.context.input.showThinking) continue
				rows.push({ ...base, kind: "thinking", key, text: part.text, redacted: part.redacted })
				continue
			}
			if (part.kind === "text") {
				const text = part.text.trim()
				if (text !== "") rows.push({ ...base, kind: "assistant", key, text: part.text, failed })
				continue
			}
			if (part.kind === "tool_call") {
				// A tool span for the same call carries the duration, the service and
				// the error; this row exists only where there is no such span.
				if (part.id !== undefined && scope.context.coveredCallIds.has(part.id)) continue
				rows.push({
					...base,
					kind: "tool",
					key,
					toolName: part.name,
					callId: part.id,
					args: payload(part.argumentsText),
					result: payload(
						part.id === undefined ? undefined : scope.context.input.toolResults.get(part.id),
					),
					failed: false,
					fromMessageOnly: true,
				})
			}
			// A `tool_result` part inside an output message is the emitter echoing
			// itself; the call's own row already resolves the result by id.
		}
	}

	if (rows.some((row) => row.kind === "assistant")) return rows

	// Nothing said. Which of the three silences it is decides what the row is.
	if (failed) {
		return [
			...rows,
			{ ...base, kind: "assistant", key: rowKey(scope, span, "failed"), text: undefined, failed: true },
		]
	}
	const promptText = promptAllowed ? capturedPromptText(messages) : undefined
	if (promptText !== undefined && output.length === 0) {
		// The Vercel AI SDK shape: the request was recorded, the reply was not.
		return [...rows, { ...base, kind: "prompt", key: rowKey(scope, span, "prompt"), text: promptText }]
	}
	// Reasoning or a tool call IS the call's output; silence after them is the
	// model going straight to work, not a missing reply.
	if (rows.length > 0) return rows
	if (messages.length > 0) {
		// This call captured something — so the reply is missing, not merely
		// unrecorded like every call in a capture-off session.
		return [
			{ ...base, kind: "assistant", key: rowKey(scope, span, "no-reply"), text: undefined, failed: false },
		]
	}
	return [
		{
			...base,
			kind: "structure",
			key: rowKey(scope, span),
			label: structureLabel(span, "inference"),
			failed: false,
		},
	]
}

/** The prompt this call was made for, when its reply was not captured. The
 *  turn's user row has already claimed the first history, so this is the text
 *  of a later, differently-captured call. */
function capturedPromptText(messages: readonly SpanMessage[]): string | undefined {
	const input = messages.filter((message) => message.origin === "input")
	for (let i = input.length - 1; i >= 0; i--) {
		if (input[i]!.role.toLowerCase() !== "user") continue
		const text = textOf(input[i]!.parts)
		if (text !== "") return text
	}
	return undefined
}

/* Capture boundary --------------------------------------------------------- */

/**
 * Where a turn's capture changes hands.
 *
 * A session can mix emitters — one service records prompts and replies, the
 * next records prompts only. Saying so once, at the seam, is the difference
 * between "the agent went quiet" and "this service does not record replies".
 */
function captureBoundaryRow(
	span: AiSessionSpan,
	messages: readonly SpanMessage[],
	scope: LaneScope,
): readonly TranscriptRow[] {
	const current = `${span.serviceName}|${captureCoverage(messages)}`
	const previous = scope.context.lastCapture
	scope.context.lastCapture = current
	if (previous === undefined || previous === current) return []
	// Only a change of emitter is worth a note: the same service capturing
	// nothing on one call is a per-call absence, already visible on that row.
	if (previous.split("|")[0] === span.serviceName) return []
	return [
		{
			kind: "note",
			key: rowKey(scope, span, "capture-boundary"),
			depth: scope.depth,
			noteKind: "capture-boundary",
			serviceName: span.serviceName,
			captures: captureCoverage(messages),
			anyCaptured: captureCoverage(messages) !== "none",
		},
	]
}

function captureCoverage(messages: readonly SpanMessage[]): CaptureCoverage {
	const hasInput = messages.some((message) => message.origin === "input")
	const hasOutput = messages.some((message) => message.origin === "output")
	if (hasInput && hasOutput) return "both"
	if (hasInput) return "input"
	if (hasOutput) return "output"
	return "none"
}

/* Tools -------------------------------------------------------------------- */

function toolRow(span: AiSessionSpan, scope: LaneScope): TranscriptRow {
	const { toolName, toolCallId, toolCallArguments, toolCallResult } = span.genAi
	// The session-wide index only fills an absence: a later call's echoed
	// response never overrides what the tool span itself reported.
	const resultText =
		toolCallResult !== undefined
			? jsonText(toolCallResult)
			: toolCallId === undefined
				? undefined
				: scope.context.input.toolResults.get(toolCallId)

	return {
		kind: "tool",
		key: rowKey(scope, span),
		depth: scope.depth,
		span,
		startMs: spanStartMs(span),
		toolName,
		callId: toolCallId,
		args: payload(toolCallArguments === undefined ? undefined : jsonText(toolCallArguments)),
		result: payload(resultText),
		failed: spanFailed(span),
		fromMessageOnly: false,
	}
}

/* -------------------------------------------------------------------------- */
/* Payloads                                                                   */
/* -------------------------------------------------------------------------- */

/** Trailing marker instrumentations append when they cut a payload short. */
const TRUNCATION_MARKER = /…\s*\[truncated\]\s*$/

/**
 * A captured payload, and whether the emitter had already cut it off.
 *
 * Two shapes in the wild: a `{ truncated: true, prefix }` envelope, and a
 * trailing `…[truncated]` marker. Both are unwrapped to the text that IS there
 * and flagged, because a reader who cannot tell emitter truncation from the
 * view's own clamping will look for a "show full" that can never exist.
 */
export function payload(text: string | undefined): TranscriptPayload | undefined {
	if (text === undefined || text === "") return undefined

	const envelope = truncationEnvelope(text)
	const body = envelope ?? text
	const marked = TRUNCATION_MARKER.test(body)
	const shown = marked ? body.replace(TRUNCATION_MARKER, "") : body

	return {
		text: shown,
		byteLength: utf8Length(shown),
		lineCount: countLines(shown),
		truncatedByEmitter: envelope !== undefined || marked,
	}
}

function truncationEnvelope(text: string): string | undefined {
	if (!text.startsWith("{") || !text.includes('"truncated"')) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return undefined
	}
	if (!isRecord(parsed) || parsed.truncated !== true) return undefined
	const prefix = parsed.prefix ?? parsed.value ?? parsed.content
	return typeof prefix === "string" ? prefix : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** UTF-8 length without materialising a copy: a session's payloads can run to
 *  megabytes and this is computed for every one of them. */
function utf8Length(text: string): number {
	let bytes = 0
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code < 0x80) bytes += 1
		else if (code < 0x800) bytes += 2
		else if (code >= 0xd800 && code < 0xdc00) {
			bytes += 4
			i++
		} else bytes += 3
	}
	return bytes
}

function countLines(text: string): number {
	let lines = 1
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++
	return lines
}

/* -------------------------------------------------------------------------- */
/* Filtering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The toolbar's filter, applied to blocks rather than to spans: in a transcript
 * the text IS the content, so a query has to reach the messages and not only
 * the span names. Structural chrome — lane headers, parallel markers, notes —
 * is dropped with the filter on: it describes an ordering the filtered view no
 * longer has.
 */
function filterRows(rows: readonly TranscriptRow[], query: string): readonly TranscriptRow[] {
	const needle = query.trim().toLowerCase()
	if (needle === "") return rows
	return rows.filter((row) => {
		const haystack = rowText(row)
		return haystack !== undefined && haystack.toLowerCase().includes(needle)
	})
}

function rowText(row: TranscriptRow): string | undefined {
	switch (row.kind) {
		case "user":
		case "system":
		case "prompt":
			return row.text
		case "assistant":
		case "thinking":
			return row.text
		case "tool":
			return [row.toolName, row.args?.text, row.result?.text].filter(Boolean).join("\n")
		case "structure":
			return row.label
		default:
			return undefined
	}
}

/* -------------------------------------------------------------------------- */
/* Shared bits                                                                */
/* -------------------------------------------------------------------------- */

/** Has this call captured anything a reader could read? */
export function hasCapturedContent(span: AiSessionSpan): boolean {
	const { systemInstructions, inputMessages, outputMessages } = span.genAi
	return (
		(systemInstructions !== undefined && systemInstructions !== null) ||
		(inputMessages !== undefined && inputMessages !== null) ||
		(outputMessages !== undefined && outputMessages !== null)
	)
}

/** "chat gpt-5", "tool run_sql", "agent db-lane" — the span reduced to what it
 *  was, in the same words the span name uses. */
function structureLabel(span: AiSessionSpan, category: string): string {
	if (category === "tool") return `tool ${span.genAi.toolName ?? span.spanName}`
	if (category === "agent") return `agent ${span.genAi.agentName ?? span.spanName}`
	const model = spanModel(span)
	return model === undefined ? span.spanName : `chat ${model}`
}

function textOf(parts: readonly SpanMessagePart[]): string {
	return parts
		.map((part) => (part.kind === "text" ? part.text : ""))
		.join("\n")
		.trim()
}

function dedupeById(spans: readonly AiSessionSpan[]): readonly AiSessionSpan[] {
	const seen = new Set<string>()
	return spans.filter((span) => (seen.has(span.spanId) ? false : (seen.add(span.spanId), true)))
}

function distinct(values: readonly string[]): readonly string[] {
	return [...new Set(values)]
}

function jsonText(value: unknown): string {
	if (typeof value === "string") return value
	const text = JSON.stringify(value)
	return text === undefined ? String(value) : text
}
