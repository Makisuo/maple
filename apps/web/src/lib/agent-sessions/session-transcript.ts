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
	type AiSpanCategory,
	type SessionTurn,
} from "./session-turns"
import {
	isRecord,
	jsonText,
	spanMessages,
	toolResultFor,
	type SessionToolResults,
	type SpanMessage,
	type SpanMessagePart,
} from "./span-detail"

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

/**
 * One turn the reader can be sent to, for a chapter marker's jump link.
 *
 * The turn rides along rather than a formatted label: the ordinal the page
 * prints ("Turn 4" / "Segment 2") is the view's wording, and re-deriving it here
 * would put the same rule in two places.
 */
export interface TranscriptTurnRef {
	/** The turn header row's own key, so a jump resolves against the row list. */
	readonly key: string
	readonly turn: SessionTurn
}

/** The payload of a tool call or its result, with what the emitter did to it. */
export interface TranscriptPayload {
	/** Empty where the emitter recorded that it truncated but kept no prefix. */
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
			/** AI spans the turn actually renders — deduped, app spans excluded. */
			readonly aiSpanCount: number
			readonly toolNames: readonly string[]
	  })
	/** A turn the transcript has nothing to say about, holding its ordinal open. */
	| (RowBase & { readonly kind: "empty-turn"; readonly turn: SessionTurn })
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
			/** Model calls in the turn — `callCount` out of how many. */
			readonly turnCallCount: number
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
			/** What the delegating tool call asked for, where a lane was delegated. */
			readonly args: TranscriptPayload | undefined
	  })
	| (RowBase & {
			readonly kind: "lane-close"
			readonly laneKind: LaneKind
			readonly agentName: string
			readonly parentAgentName: string | undefined
			readonly durationMs: number
			readonly llmCalls: number
			readonly toolCalls: number
			/** What the sub-agent returned, where the delegation captured it. */
			readonly result: TranscriptPayload | undefined
	  })
	| (RowBase & {
			readonly kind: "parallel"
			/** The fork: from the first lane opening to the last one closing. */
			readonly startMs: number
			readonly endMs: number
			/** The window every lane in the cluster was open in, where there is one.
			 *  A chain of pairwise overlaps has none, and claiming a window there
			 *  would be the invention the marker exists to prevent. */
			readonly overlapStartMs: number | undefined
			readonly overlapEndMs: number | undefined
			readonly lanes: readonly TranscriptLaneRef[]
	  })
	/** The same announcement one level up: turns that ran at the same time. */
	| (RowBase & {
			readonly kind: "parallel-turns"
			/** The cluster: from the first turn starting to the last one ending. */
			readonly startMs: number
			readonly endMs: number
			/** The window every turn in the cluster was open in, where there is one.
			 *  A chain of pairwise overlaps has none. */
			readonly overlapStartMs: number | undefined
			readonly overlapEndMs: number | undefined
			readonly turns: readonly TranscriptTurnRef[]
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
			readonly noteKind: "capture-off"
			/** Whether the note is about the whole session or about one turn. */
			readonly scope: "session" | "turn"
			/** Whether ANY call in scope captured content. */
			readonly anyCaptured: boolean
	  })
	| (RowBase & {
			readonly kind: "note"
			readonly noteKind: "capture-boundary"
			/** The service whose capture differs. */
			readonly serviceName: string | undefined
			/** What that service records, over every call it made this turn. */
			readonly captures: CaptureCoverage
	  })
	| (RowBase & {
			readonly kind: "divider"
			readonly dividerKind: TranscriptDividerKind
			readonly startMs: number | undefined
	  })

export interface TranscriptInput {
	readonly turns: readonly SessionTurn[]
	/** Session-wide results by tool call id (`sessionToolResults`). */
	readonly toolResults: SessionToolResults
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
	// `classifyAiSpan` re-reads the same attributes every time the build asks
	// what a span is, and a build asks five to eight times per span. One cache
	// for the whole build, alongside the per-turn message cache.
	const categories = new Map<string, AiSpanCategory>()
	const categoryOf = (span: AiSessionSpan): AiSpanCategory => {
		const cached = categories.get(span.spanId)
		if (cached !== undefined) return cached
		const category = classifyAiSpan(span)
		categories.set(span.spanId, category)
		return category
	}

	const filtering = input.query.trim() !== ""
	const turnRows = input.turns.map((turn) => buildTurn(turn, input, categoryOf))
	// Structural chrome, like the lane markers: a filtered view no longer has the
	// ordering the marker describes, so it is not built at all.
	const concurrent = filtering ? new Map<string, TranscriptRow | undefined>() : markParallelTurns(turnRows)

	// Capture coverage is a fact about the session, so it is counted over every
	// turn before the first row is emitted.
	const llmSpans = turnRows.flatMap((entry) => entry.llmSpans)
	const capturedCalls = llmSpans.filter(hasCapturedContent).length
	const bannerUp = llmSpans.length > 0 && capturedCalls / llmSpans.length < CAPTURE_BANNER_THRESHOLD
	// A session of pure HTTP/DB work has no transcript at all; only one that DOES
	// have agent work keeps placeholders for the turns without it.
	const anyAiActivity = turnRows.some((entry) => entry.aiSpanCount > 0)

	const body: TranscriptRow[] = []
	for (const entry of turnRows) {
		// The fallback turn partition is one turn per trace, so a session of pure
		// HTTP/DB work still produces turns. With no AI span in it a turn has
		// nothing a transcript can say — but omitting it outright would renumber
		// the page against Traces and Flow, so one muted row holds its ordinal.
		if (entry.aiSpanCount === 0) {
			if (anyAiActivity && !filtering) {
				body.push({ kind: "empty-turn", key: `empty:${entry.turn.id}`, depth: 0, turn: entry.turn })
			}
			continue
		}
		// A turn whose every block was filtered out drops off the page entirely —
		// a header over nothing is worse than no header. Collapse does not change
		// that: the filter judges both states by the same rows.
		if (filtering && entry.rows.length === 0) continue
		// The marker opens the cluster, so it is carried by its first member.
		const marker = concurrent.get(entry.turn.id)
		if (marker !== undefined) body.push(marker)
		// A cluster member's whole chapter shifts one lane right, the same move a
		// lane makes inside a turn: the indentation is what says "these chapters
		// hang off the fork above" without the reader having to parse the marker.
		const indent = concurrent.has(entry.turn.id) ? 1 : 0
		body.push(indent === 0 ? entry.header : { ...entry.header, depth: entry.header.depth + indent })
		// Per-turn only where the session-level banner is not already up.
		if (
			!bannerUp &&
			entry.llmSpans.length > 0 &&
			entry.llmSpans.every((span) => !hasCapturedContent(span))
		) {
			body.push({
				kind: "note",
				key: `note:${entry.turn.id}`,
				depth: indent,
				noteKind: "capture-off",
				scope: "turn",
				anyCaptured: false,
			})
		}
		if (!input.collapsedTurns.has(entry.turn.id)) {
			body.push(
				...(indent === 0
					? entry.rows
					: entry.rows.map((row) => ({ ...row, depth: row.depth + indent }))),
			)
		}
	}

	// Nothing survived. The empty state says which of the two reasons it was, and
	// a lone banner or a divider hanging over nothing would only muddy it.
	if (body.length === 0) return []

	const rows: TranscriptRow[] = []
	if (bannerUp) {
		rows.push({
			kind: "note",
			key: "note:session-capture",
			depth: 0,
			noteKind: "capture-off",
			scope: "session",
			anyCaptured: capturedCalls > 0,
		})
	}
	rows.push(...body)

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
	readonly header: Extract<TranscriptRow, { kind: "turn" }>
	readonly rows: readonly TranscriptRow[]
	/** The turn's model calls, for the session's capture coverage. */
	readonly llmSpans: readonly AiSessionSpan[]
	readonly aiSpanCount: number
}

function buildTurn(
	turn: SessionTurn,
	input: TranscriptInput,
	categoryOf: (span: AiSessionSpan) => AiSpanCategory,
): TurnRows {
	// Non-AI spans are the app's own HTTP/DB work sharing the agent's traces and
	// have no place in a conversation; a duplicate span id would render its
	// block twice.
	const spans = dedupeById(turn.spans).filter((span) => span.isAiSpan)
	const llmSpans = spans.filter(isLlmCall)
	const toolSpans = spans.filter((span) => categoryOf(span) === "tool")

	const header: Extract<TranscriptRow, { kind: "turn" }> = {
		kind: "turn",
		key: turn.id,
		depth: 0,
		turn,
		startMs: turn.startMs,
		llmCalls: llmSpans.length,
		toolCalls: toolSpans.length,
		aiSpanCount: spans.length,
		toolNames: distinct(
			toolSpans.map((span) => span.genAi.toolName).filter((name): name is string => name !== undefined),
		),
	}

	// A collapsed turn renders its header and nothing else, so none of the work
	// below — a JSON parse per captured span, then the forest walk — would ever
	// reach the page. With a filter on it does reach it: the filter decides
	// whether the header itself survives, and that is read off the rows.
	const filtering = input.query.trim() !== ""
	if (input.collapsedTurns.has(turn.id) && !filtering) {
		return { turn, header, rows: [], llmSpans, aiSpanCount: spans.length }
	}

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
		categoryOf,
		// Call ids a tool span already accounts for: an output message's
		// `tool_call` part describes the same call, and rendering both would
		// count one invocation twice.
		coveredCallIds: new Set(
			toolSpans.map((span) => span.genAi.toolCallId).filter((id): id is string => id !== undefined),
		),
		unclaimedToolNames: countIdlessToolSpans(toolSpans),
		systemCounts: countSystemInstructions(llmSpans, messagesOf),
		turnCallCount: llmSpans.length,
		serviceCoverage: coverageByService(llmSpans, messagesOf),
		emittedSystem: new Set<string>(),
		userEmitted: false,
		lastService: undefined,
	}

	const forest = buildForest(spans)
	const walk = walkLane(forest.roots, forest.children, {
		context,
		depth: 0,
		agentName: turn.agentName,
		keyPrefix: turn.id,
	})

	return { turn, header, rows: filterRows(walk.rows, input.query), llmSpans, aiSpanCount: spans.length }
}

interface TurnContext {
	readonly turn: SessionTurn
	readonly input: TranscriptInput
	/** Per-turn cache over `spanMessages` — the captured JSON is parsed once. */
	readonly messagesOf: (span: AiSessionSpan) => readonly SpanMessage[]
	/** Per-build cache over `classifyAiSpan`. */
	readonly categoryOf: (span: AiSessionSpan) => AiSpanCategory
	readonly coveredCallIds: ReadonlySet<string>
	/** Tool spans no call id can ever claim, by name — see `countIdlessToolSpans`. */
	readonly unclaimedToolNames: Map<string, number>
	readonly systemCounts: ReadonlyMap<string, number>
	/** Model calls in the turn, so a system row can say "N of M". */
	readonly turnCallCount: number
	readonly serviceCoverage: ReadonlyMap<string, CaptureCoverage>
	/** System text already shown this turn — emitters re-send it every call. */
	readonly emittedSystem: Set<string>
	/** The turn's user message comes from the FIRST captured history only. */
	userEmitted: boolean
	/** The last model call's service, for the capture-boundary note. */
	lastService: string | undefined
}

/**
 * Tool spans in this turn that carry no `gen_ai.tool.call.id`, counted by name.
 *
 * An id-less `tool_call` part in an output message cannot be matched to its
 * span by id, so without this the call renders twice: once first-hand from the
 * span, once again from the message that made it. The tool NAME is the only
 * evidence left, and it is spent conservatively — only against spans that no id
 * could ever have claimed, and one span per part, so two calls to the same tool
 * still read as two.
 */
function countIdlessToolSpans(toolSpans: readonly AiSessionSpan[]): Map<string, number> {
	const counts = new Map<string, number>()
	for (const span of toolSpans) {
		if (span.genAi.toolCallId !== undefined) continue
		const name = span.genAi.toolName
		if (name === undefined) continue
		counts.set(name, (counts.get(name) ?? 0) + 1)
	}
	return counts
}

/**
 * What each service in this turn captures, over ALL of its calls.
 *
 * A boundary note names what the emitter below it records, and reading that off
 * the FIRST call after the seam gets it wrong wherever that call errored before
 * recording anything: the note would say "records no message content" of a
 * service whose very next call captures both halves.
 */
function coverageByService(
	llmSpans: readonly AiSessionSpan[],
	messagesOf: (span: AiSessionSpan) => readonly SpanMessage[],
): ReadonlyMap<string, CaptureCoverage> {
	const inputs = new Set<string>()
	const outputs = new Set<string>()
	const services = new Set<string>()
	for (const span of llmSpans) {
		services.add(span.serviceName)
		for (const message of messagesOf(span)) {
			if (message.origin === "input") inputs.add(span.serviceName)
			else if (message.origin === "output") outputs.add(span.serviceName)
		}
	}
	const coverage = new Map<string, CaptureCoverage>()
	for (const service of services) {
		coverage.set(service, coverageOf(inputs.has(service), outputs.has(service)))
	}
	return coverage
}

function coverageOf(hasInput: boolean, hasOutput: boolean): CaptureCoverage {
	if (hasInput && hasOutput) return "both"
	if (hasInput) return "input"
	if (hasOutput) return "output"
	return "none"
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
 *
 * TODO: `session-waterfall.tsx`'s `orderByTree` builds the same forest and could
 * read this one, but it deliberately preserves input order where this sorts —
 * unifying them is a behavioural change to the waterfall, not a lift.
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

/** What a walk covered, for a lane's header and closing summary. Counted while
 *  the rows are built rather than by re-walking the subtree afterwards. */
interface WorkCounts {
	spans: number
	llmCalls: number
	toolCalls: number
}

interface LaneWalk {
	readonly rows: readonly TranscriptRow[]
	readonly counts: WorkCounts
}

/** A lane's rows, held whole so overlapping lanes can be marked before either
 *  of them is emitted. */
interface LaneBlock {
	readonly rows: readonly TranscriptRow[]
	readonly ref: TranscriptLaneRef
	readonly startMs: number
	readonly endMs: number
	/** Everything the block contributes to the thread that contains it. */
	readonly counts: WorkCounts
	/** Index in the parent's row list where the lane's first row goes. */
	readonly at: number
}

function noWork(): WorkCounts {
	return { spans: 0, llmCalls: 0, toolCalls: 0 }
}

function addWork(into: WorkCounts, from: WorkCounts): void {
	into.spans += from.spans
	into.llmCalls += from.llmCalls
	into.toolCalls += from.toolCalls
}

function countSpan(into: WorkCounts, span: AiSessionSpan, scope: LaneScope): void {
	into.spans++
	if (isLlmCall(span)) into.llmCalls++
	else if (scope.context.categoryOf(span) === "tool") into.toolCalls++
}

function walkLane(
	spans: readonly AiSessionSpan[],
	children: ReadonlyMap<string, readonly AiSessionSpan[]>,
	scope: LaneScope,
): LaneWalk {
	const rows: TranscriptRow[] = []
	const lanes: LaneBlock[] = []
	const counts = noWork()

	for (const span of spans) {
		// The turn's own anchor is what the chapter header already describes;
		// repeating it as a row would open every turn with a restatement. Only an
		// AGENT anchor, though: a conversation-id partition can anchor a turn on
		// the model call that opened it, and that call's reply is the turn.
		if (span.spanId === scope.context.turn.anchor.spanId && scope.context.categoryOf(span) === "agent") {
			const inner = walkLane(children.get(span.spanId) ?? [], children, scope)
			rows.push(...inner.rows)
			addWork(counts, inner.counts)
			continue
		}

		const lane = openedLane(span, children, scope)
		if (lane !== undefined) {
			lanes.push({ ...lane, at: rows.length })
			rows.push(...lane.rows)
			addWork(counts, lane.counts)
			continue
		}
		countSpan(counts, span, scope)
		rows.push(...spanRows(span, scope))
		const inner = walkLane(children.get(span.spanId) ?? [], children, scope)
		rows.push(...inner.rows)
		addWork(counts, inner.counts)
	}

	return { rows: markParallelLanes(rows, lanes, scope), counts }
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
 * Its payloads are not collapsed with it: the task prompt and the answer the
 * sub-agent returned ride on the block's opening and closing rows.
 */
function openedLane(
	span: AiSessionSpan,
	children: ReadonlyMap<string, readonly AiSessionSpan[]>,
	scope: LaneScope,
): Omit<LaneBlock, "at"> | undefined {
	const agentSpan = delegationTarget(span, children, scope)
	if (agentSpan === undefined) return undefined

	const agentName = agentSpan.genAi.agentName
	if (agentName === undefined) return undefined

	const key = `${scope.keyPrefix}:lane:${agentSpan.spanId}`
	const inner = children.get(agentSpan.spanId) ?? []
	const walk = walkLane(inner, children, {
		context: scope.context,
		depth: scope.depth + 1,
		agentName,
		keyPrefix: key,
	})
	// A handoff the agent made by CALLING a tool is a sub-agent it delegated to;
	// an agent span forked directly is a branch of the same run. The distinction
	// is in the data (`execute_tool task` → `invoke_agent`), not in the depth.
	const laneKind: LaneKind = agentSpan.spanId === span.spanId ? "lane" : "subagent"
	const delegating = laneKind === "subagent" ? span : undefined

	// The enclosing thread counts the whole block: the agent span, the tool span
	// the block swallowed, and everything the walk covered under them.
	const counts = { ...walk.counts }
	countSpan(counts, agentSpan, scope)
	if (delegating !== undefined) countSpan(counts, delegating, scope)

	return {
		ref: { key, agentName },
		startMs: spanStartMs(span),
		endMs: Math.max(spanEndMs(span), spanEndMs(agentSpan)),
		counts,
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
				spanCount: walk.counts.spans,
				args: payload(delegating === undefined ? undefined : toolArgsText(delegating)),
			},
			...walk.rows,
			{
				kind: "lane-close",
				key: `${key}:close`,
				depth: scope.depth + 1,
				laneKind,
				agentName,
				parentAgentName: scope.agentName,
				durationMs: agentSpan.durationMs,
				llmCalls: walk.counts.llmCalls,
				toolCalls: walk.counts.toolCalls,
				result: payload(
					delegating === undefined ? undefined : toolResultText(delegating, scope.context),
				),
			},
		],
	}
}

/** The agent span this span hands off to: itself, or the one delegation-shaped
 *  child a `task`-style tool span exists only to invoke. */
function delegationTarget(
	span: AiSessionSpan,
	children: ReadonlyMap<string, readonly AiSessionSpan[]>,
	scope: LaneScope,
): AiSessionSpan | undefined {
	const forks = (candidate: AiSessionSpan): boolean =>
		scope.context.categoryOf(candidate) === "agent" &&
		candidate.genAi.agentName !== undefined &&
		candidate.genAi.agentName !== scope.agentName

	if (forks(span)) return span
	if (scope.context.categoryOf(span) !== "tool") return undefined
	const own = children.get(span.spanId) ?? []
	return own.length === 1 && forks(own[0]!) ? own[0] : undefined
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
	const clusters = clusterByOverlap(lanes)
	if (clusters.length === 0) return rows

	const out = [...rows]
	const markers: { at: number; row: TranscriptRow }[] = []
	for (const cluster of clusters) {
		// `at` is where the lane's rows were pushed and its opening row is the
		// first of them — the marker opens the cluster right above it.
		const first = cluster.members[0]!
		markers.push({
			at: first.at,
			row: {
				kind: "parallel",
				key: `${first.ref.key}:parallel`,
				depth: scope.depth,
				startMs: cluster.startMs,
				endMs: cluster.endMs,
				overlapStartMs: cluster.overlapStartMs,
				overlapEndMs: cluster.overlapEndMs,
				lanes: cluster.members.map((lane) => lane.ref),
			},
		})
	}

	// Back to front, so an earlier insertion never shifts a later index.
	for (const marker of markers.reverse()) out.splice(marker.at, 0, marker.row)
	return out
}

/* -------------------------------------------------------------------------- */
/* Overlap clustering                                                         */
/* -------------------------------------------------------------------------- */

/** Anything the transcript can announce as concurrent: a lane, or a turn. */
interface Interval {
	readonly startMs: number
	readonly endMs: number
}

interface OverlapCluster<T> {
	/** Two or more, in start order. */
	readonly members: readonly T[]
	/** The run's extent: first member starting to last member ending. */
	readonly startMs: number
	readonly endMs: number
	/**
	 * The window every member was open in, where there is one. A chain of
	 * pairwise overlaps has none, and claiming a window there would be the
	 * invention the marker exists to prevent — so both ends are `undefined`
	 * together rather than reported backwards.
	 */
	readonly overlapStartMs: number | undefined
	readonly overlapEndMs: number | undefined
}

/**
 * Group items that ran at the same time.
 *
 * Clustered against a RUNNING maximum end, never against the previous item's
 * own: two short runs nested inside one long one are a single cluster, and
 * reading only the last member would break the run at the first item that
 * happened to finish early. A cluster of one is a sequence and is dropped.
 *
 * The input is sorted defensively. A thread's lanes arrive in start order
 * already, but a turn is ordered by its ANCHOR while its own `startMs` is the
 * minimum over every span the time partition gave it, and the two can disagree.
 */
function clusterByOverlap<T extends Interval>(items: readonly T[]): readonly OverlapCluster<T>[] {
	if (items.length < 2) return []

	const groups: T[][] = []
	let clusterEnd = Number.NEGATIVE_INFINITY
	for (const item of [...items].sort((a, b) => a.startMs - b.startMs)) {
		const group = groups.at(-1)
		if (group !== undefined && item.startMs < clusterEnd) {
			group.push(item)
			clusterEnd = Math.max(clusterEnd, item.endMs)
		} else {
			groups.push([item])
			clusterEnd = item.endMs
		}
	}

	return groups
		.filter((group) => group.length > 1)
		.map((members) => {
			const sharedStart = Math.max(...members.map((item) => item.startMs))
			const sharedEnd = Math.min(...members.map((item) => item.endMs))
			const shared = sharedStart < sharedEnd
			return {
				members,
				startMs: members[0]!.startMs,
				endMs: Math.max(...members.map((item) => item.endMs)),
				overlapStartMs: shared ? sharedStart : undefined,
				overlapEndMs: shared ? sharedEnd : undefined,
			}
		})
}

/**
 * Chapter-level parallelism: turns that ran at the same time.
 *
 * `buildSessionTurns` partitions on `gen_ai.conversation.id` where there is one,
 * and a Maple sub-agent or workflow lane carries its own — so a fan-out the
 * parent dispatched arrives here as SIBLING turns rather than as lanes inside
 * one, and reads as "turn 3, then turn 4": the one thing the timestamps deny.
 * A dispatched run whose queue hop lost the span link lands the same way,
 * through the agent-root rule.
 *
 * Only turns the transcript actually renders take part. An `empty-turn` stub is
 * a placeholder for HTTP/DB work with no agent activity in it, and pairing one
 * with a real turn would announce a concurrency the reader cannot see.
 */
function markParallelTurns(entries: readonly TurnRows[]): ReadonlyMap<string, TranscriptRow | undefined> {
	const items = entries
		.filter((entry) => entry.aiSpanCount > 0)
		.map((entry, order) => ({
			entry,
			// Where this turn sits on the PAGE. Turns are ordered by their anchor and
			// a turn's `startMs` is the minimum over its spans, so the two can
			// disagree — and the marker has to open the cluster wherever it renders.
			order,
			startMs: entry.turn.startMs,
			endMs: entry.turn.endMs,
			ref: { key: entry.turn.id, turn: entry.turn } satisfies TranscriptTurnRef,
		}))

	// Membership is the key; only the cluster's first member carries its marker.
	const marked = new Map<string, TranscriptRow | undefined>()
	for (const cluster of clusterByOverlap(items)) {
		for (const item of cluster.members) marked.set(item.entry.turn.id, undefined)
		const first = cluster.members.reduce((a, b) => (a.order <= b.order ? a : b))
		marked.set(first.entry.turn.id, {
			kind: "parallel-turns",
			key: `${first.ref.key}:parallel-turns`,
			depth: 0,
			startMs: cluster.startMs,
			endMs: cluster.endMs,
			overlapStartMs: cluster.overlapStartMs,
			overlapEndMs: cluster.overlapEndMs,
			turns: cluster.members.map((item) => item.ref),
		})
	}
	return marked
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

	const category = context.categoryOf(span)
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
	rows.push(...captureBoundaryRow(span, scope))
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
			turnCallCount: scope.context.turnCallCount,
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
				// The Thinking chip decides whether the row is drawn. It never decides
				// what the call is held to have captured — see the silences below.
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
				if (coveredBySpan(part, scope.context)) continue
				rows.push({
					...base,
					kind: "tool",
					key,
					toolName: part.name,
					callId: part.id,
					args: payload(part.argumentsText),
					result: payload(
						part.id === undefined
							? undefined
							: toolResultFor(scope.context.input.toolResults, span.traceId, part.id),
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

	// Nothing said. Which of the silences it is decides what the row is.
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
	// model going straight to work, not a missing reply. That is read off the
	// captured messages, not off the rows: a hidden thinking row and a tool call
	// a span already covers both leave `rows` empty without the reply having
	// gone anywhere.
	if (output.length > 0) return rows
	if (messages.length > 0) {
		// This call captured something — so the reply is missing, not merely
		// unrecorded like every call in a capture-off session.
		return [
			{
				...base,
				kind: "assistant",
				key: rowKey(scope, span, "no-reply"),
				text: undefined,
				failed: false,
			},
		]
	}
	return [
		{
			...base,
			kind: "structure",
			key: rowKey(scope, span),
			label: structureLabel(span, scope.context.categoryOf(span)),
			failed: false,
		},
	]
}

/** Does a tool span already account for this `tool_call` part? */
function coveredBySpan(part: Extract<SpanMessagePart, { kind: "tool_call" }>, context: TurnContext): boolean {
	// A tool span for the same call carries the duration, the service and the
	// error; the message-only row exists only where there is no such span.
	if (part.id !== undefined) return context.coveredCallIds.has(part.id)
	if (part.name === undefined) return false
	const unclaimed = context.unclaimedToolNames.get(part.name)
	if (unclaimed === undefined || unclaimed === 0) return false
	context.unclaimedToolNames.set(part.name, unclaimed - 1)
	return true
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
 * Only a change of EMITTER is worth a note: the same service capturing nothing
 * on one call is a per-call absence, already visible on that call's own row.
 */
function captureBoundaryRow(span: AiSessionSpan, scope: LaneScope): readonly TranscriptRow[] {
	const previous = scope.context.lastService
	scope.context.lastService = span.serviceName
	if (previous === undefined || previous === span.serviceName) return []
	return [
		{
			kind: "note",
			key: rowKey(scope, span, "capture-boundary"),
			depth: scope.depth,
			noteKind: "capture-boundary",
			serviceName: span.serviceName,
			captures: scope.context.serviceCoverage.get(span.serviceName) ?? "none",
		},
	]
}

/* Tools -------------------------------------------------------------------- */

function toolRow(span: AiSessionSpan, scope: LaneScope): TranscriptRow {
	return {
		kind: "tool",
		key: rowKey(scope, span),
		depth: scope.depth,
		span,
		startMs: spanStartMs(span),
		toolName: span.genAi.toolName,
		callId: span.genAi.toolCallId,
		args: payload(toolArgsText(span)),
		result: payload(toolResultText(span, scope.context)),
		failed: spanFailed(span),
		fromMessageOnly: false,
	}
}

/**
 * A tool span's captured arguments, as display text.
 *
 * `?? undefined` rather than an `=== undefined` test: captured attributes decode
 * through `Schema.Unknown`, so an emitter that wrote JSON `null` lands here as
 * `null`. Both mean "not captured", and `jsonText(null)` would render the string
 * "null" as though it were the payload.
 */
function toolArgsText(span: AiSessionSpan): string | undefined {
	const args = span.genAi.toolCallArguments ?? undefined
	return args === undefined ? undefined : jsonText(args)
}

/** A tool span's captured result. The session-wide index only fills an absence:
 *  a later call's echoed response never overrides the span's own report. */
function toolResultText(span: AiSessionSpan, context: TurnContext): string | undefined {
	const own = span.genAi.toolCallResult ?? undefined
	if (own !== undefined) return jsonText(own)
	const id = span.genAi.toolCallId
	return id === undefined ? undefined : toolResultFor(context.input.toolResults, span.traceId, id)
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
	const { byteLength, lineCount } = measure(shown)

	return { text: shown, byteLength, lineCount, truncatedByEmitter: envelope !== undefined || marked }
}

/**
 * Keys a truncation envelope is allowed to carry.
 *
 * `{ truncated: true }` is not by itself an envelope: an emitter that returns
 * `{ rows: [...], truncated: true }` is telling the reader its RESULT was
 * truncated, and unwrapping that to a missing `prefix` would throw the rows
 * away. So an object is only an envelope when it carries nothing but the
 * wrapper's own keys — otherwise it is a payload and renders whole.
 */
const ENVELOPE_KEYS = new Set(["truncated", "prefix", "value", "content"])

function truncationEnvelope(text: string): string | undefined {
	if (!text.startsWith("{") || !text.includes('"truncated"')) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return undefined
	}
	if (!isRecord(parsed) || parsed.truncated !== true) return undefined
	if (Object.keys(parsed).some((key) => !ENVELOPE_KEYS.has(key))) return undefined
	// A prefix-less envelope is still an envelope: the emitter recorded that it
	// cut the payload and kept none of it. The empty text is what there is.
	const prefix = parsed.prefix ?? parsed.value ?? parsed.content
	return typeof prefix === "string" ? prefix : ""
}

/** UTF-8 length and line count in one pass, without materialising a copy: a
 *  session's payloads can run to megabytes and every one of them is measured. */
function measure(text: string): { byteLength: number; lineCount: number } {
	let bytes = 0
	let lines = text === "" ? 0 : 1
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code === 10) lines++
		if (code < 0x80) bytes += 1
		else if (code < 0x800) bytes += 2
		else if (code >= 0xd800 && code < 0xdc00) {
			bytes += 4
			// The trailing surrogate is part of the same code point, and is never a
			// newline, so skipping it costs nothing.
			i++
		} else bytes += 3
	}
	return { byteLength: bytes, lineCount: lines }
}

/* -------------------------------------------------------------------------- */
/* Filtering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The toolbar's filter, applied to blocks rather than to spans: in a transcript
 * the text IS the content, so a query has to reach the messages and not only
 * the span names. Structural chrome — lane headers, parallel markers, notes —
 * is dropped with the filter on: it describes an ordering the filtered view no
 * longer has. With the chrome gone the surviving rows are flattened too, since
 * their indentation would point at lanes that are no longer on the page.
 */
function filterRows(rows: readonly TranscriptRow[], query: string): readonly TranscriptRow[] {
	const needle = query.trim().toLowerCase()
	if (needle === "") return rows
	return rows
		.filter((row) => {
			const haystack = rowText(row)
			return haystack !== undefined && haystack.toLowerCase().includes(needle)
		})
		.map((row) => (row.depth === 0 ? row : { ...row, depth: 0 }))
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

/**
 * Has this call captured any of the CONVERSATION?
 *
 * System instructions alone do not count. An emitter that records only the
 * system prompt has captured no exchange — the words the reader came for are
 * still missing — so a session of those calls still earns the capture-off
 * banner, and the instructions still render where they were captured.
 */
function hasCapturedContent(span: AiSessionSpan): boolean {
	const { inputMessages, outputMessages } = span.genAi
	return (
		(inputMessages !== undefined && inputMessages !== null) ||
		(outputMessages !== undefined && outputMessages !== null)
	)
}

/** "chat gpt-5", "tool run_sql", "agent db-lane" — the span reduced to what it
 *  was, in the same words the span name uses. */
function structureLabel(span: AiSessionSpan, category: AiSpanCategory): string {
	switch (category) {
		case "tool":
			return `tool ${span.genAi.toolName ?? span.spanName}`
		case "agent":
			return `agent ${span.genAi.agentName ?? span.spanName}`
		case "inference": {
			const model = spanModel(span)
			if (model === undefined) return span.spanName
			// `embeddings` and `retrieval` are inference-shaped but are not model
			// turns; labelling them "chat" would claim an exchange that never
			// happened, so they are named by the operation they ran.
			const operation = span.genAi.operationName
			const verb = !isLlmCall(span) && operation !== undefined ? operation : "chat"
			return `${verb} ${model}`
		}
		case "other":
			return span.spanName
	}
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
