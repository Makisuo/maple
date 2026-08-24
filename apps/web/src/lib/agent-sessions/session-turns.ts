// Session structure: what a span is, and where one turn ends and the next begins.
//
// A session arrives as a flat list of spans drawn from several traces and
// services, and the detail page's whole value is recovering the shape of the
// conversation that produced them. No framework records "this is turn 4", so
// every rule below is a heuristic over the OTel gen_ai attributes — which is
// exactly why they live here, named and commented, instead of inside the
// components that render them.
//
// Timestamps are parsed as reported, without the clock-skew correction
// `span-tree.ts` applies inside a single trace, so a child that a skewed clock
// placed outside its parent can land in a neighbouring turn.

import type { AiSessionSpan } from "@maple/domain/http"
import { toEpochMs } from "@maple/ui/lib/time-format"

/**
 * How a span reads on the page. Deliberately coarse — these four are the
 * distinctions the waterfall colors, the occupancy bar splits on, and the work
 * counters tally, and nothing else needs a finer taxonomy.
 */
export type AiSpanCategory = "agent" | "inference" | "tool" | "other"

// `gen_ai.operation.name` is an open set, so these group the semantic
// convention's operation names plus `agent_step`, which the Vercel AI SDK emits
// and production data carries. An unknown value falls through to the span-name
// rules below rather than being rejected.
const INFERENCE_OPS = new Set(["chat", "generate_content", "text_completion", "fetch_response"])
/** Inference-shaped work that is not a chat completion: counted as inference
 *  occupancy, never as an "llm call" — an embedding is not a model turn. */
const RETRIEVAL_OPS = new Set(["embeddings", "retrieval"])
const TOOL_OPS = new Set(["execute_tool"])
const AGENT_OPS = new Set(["invoke_agent", "create_agent", "invoke_workflow", "plan", "agent_step"])

export function spanStartMs(span: AiSessionSpan): number {
	return toEpochMs(span.timestamp)
}

export function spanEndMs(span: AiSessionSpan): number {
	return spanStartMs(span) + span.durationMs
}

/** The model the span actually ran on, falling back to the one it asked for. */
export function spanModel(span: AiSessionSpan): string | undefined {
	return span.genAi.responseModel ?? span.genAi.requestModel
}

export function classifyAiSpan(span: AiSessionSpan): AiSpanCategory {
	const operation = span.genAi.operationName
	if (operation !== undefined) {
		if (INFERENCE_OPS.has(operation) || RETRIEVAL_OPS.has(operation)) return "inference"
		if (TOOL_OPS.has(operation)) return "tool"
		if (AGENT_OPS.has(operation)) return "agent"
	}
	// Spans with no AI signal at all are the app's own HTTP/DB work, sharing the
	// agent's traces. They are rendered, muted, and never colored as agent work.
	if (!span.isAiSpan) return "other"

	// `gen_ai.operation.name` is optional and plenty of instrumentations skip it.
	// The span name is the next best evidence: by convention it leads with the
	// operation ("execute_tool read_file", "chat gpt-5").
	const name = span.spanName.toLowerCase()
	if (span.genAi.toolName !== undefined || name.includes("tool")) return "tool"
	if (name.includes("agent") || name.includes("workflow")) return "agent"
	if (spanModel(span) !== undefined || name.includes("chat") || name.includes("completion")) {
		return "inference"
	}
	// An AI span we can't place is still the agent's own work, not the app's.
	return "agent"
}

/**
 * A model turn — one request/response with a model, and what the header counts
 * as an "llm call". Embeddings and retrieval are excluded: they are inference
 * time, but counting them here would make the calls-per-turn ratio (the agent's
 * loop depth) meaningless.
 *
 * Everything else `classifyAiSpan` reads as inference counts, including the
 * open-set operation names vendors invent (`generate_text`): matching only the
 * documented four would color a span as inference and then leave it out of the
 * call count, the model rows and the token column.
 */
export function isLlmCall(span: AiSessionSpan): boolean {
	const operation = span.genAi.operationName
	if (operation !== undefined && RETRIEVAL_OPS.has(operation)) return false
	return classifyAiSpan(span) === "inference"
}

/** `gen_ai.response.status` values that mean the generation failed. Semconv's
 *  enum value is `failed`; `error` is kept for dialects that predate it. */
const FAILED_RESPONSE_STATUSES = new Set(["failed", "error"])

/**
 * Whether the span reports a failure — by its own status, or by attribute.
 *
 * Frameworks routinely record a failed model or tool call as a *value* on a
 * span whose status is `Ok`: the stream completed, the operation inside it did
 * not. Reading only span status reports zero errors for exactly the failures
 * an agent view exists to show — so an AI span carrying `error.type` (which
 * semconv sets only when the operation errored) or a failed
 * `gen_ai.response.status` counts too. Scoped to AI spans because HTTP
 * instrumentation legitimately stamps `error.type` on expected 4xx requests
 * whose span status is deliberately not `Error`.
 */
export function spanFailed(span: AiSessionSpan): boolean {
	if (span.statusCode === "Error") return true
	if (!span.isAiSpan) return false
	const errorType = span.genAi.errorType
	if (errorType !== undefined && errorType !== "") return true
	const status = span.genAi.responseStatus
	return status !== undefined && FAILED_RESPONSE_STATUSES.has(status.toLowerCase())
}

/** `gen_ai.response.time_to_first_chunk` is in SECONDS (see ai-vendors.ts). */
export function spanTtftMs(span: AiSessionSpan): number | undefined {
	const seconds = span.genAi.responseTimeToFirstChunk
	if (seconds === undefined || seconds <= 0) return undefined
	const ms = seconds * 1000
	// A TTFT longer than the span it belongs to is a unit mix-up somewhere
	// upstream; drawing it would push the streaming segment negative.
	return ms > span.durationMs ? undefined : ms
}

/** Which of the three rules below produced a turn boundary — the waterfall
 *  labels the turn by it. */
export type TurnAnchorKind = "conversation" | "agent-root" | "trace"

export interface SessionTurn {
	readonly id: string
	/** 1-based, in start order — the `TURN n` the page prints. */
	readonly index: number
	readonly anchorKind: TurnAnchorKind
	/** The span that opened the turn. */
	readonly anchor: AiSessionSpan
	/** The turn's newest user message, when the vendor captured message content. */
	readonly label: string | undefined
	readonly agentName: string | undefined
	readonly startMs: number
	readonly endMs: number
	readonly durationMs: number
	/** Every span of the turn, in start order. */
	readonly spans: readonly AiSessionSpan[]
	/** An AI span that roots the turn ended `Error` — the turn did not close cleanly. */
	readonly failed: boolean
	/** Traces the turn's spans came from, first-seen first. A turn may cross traces. */
	readonly traceIds: readonly string[]
}

interface TurnAnchor {
	readonly span: AiSessionSpan
	readonly kind: TurnAnchorKind
	readonly id: string
}

/**
 * Split a session's spans into turns.
 *
 * Three rules, tried in order, because there is no single attribute that marks
 * "the user said something new":
 *
 * 1. `gen_ai.conversation.id` — the only turn key the convention has, and the
 *    one eve stamps with its turn id. One id, one turn. `findAnchors` requires
 *    more than one distinct id, and ignores vendors that derive the session id
 *    from it; it does not check that the ids are non-interleaved in time, so a
 *    vendor stamping one per concurrent sub-agent would mis-partition here.
 * 2. Agent invocations with no agent above them — a session with no usable
 *    conversation id still opens each turn by invoking the agent.
 * 3. One turn per trace — the floor. Wrong for a trace holding several turns,
 *    but it never merges two traces into one turn, and it always renders.
 *
 * Assignment is by time, not by parentage: a turn owns every span that started
 * before the next turn did, whatever trace or service it came from. Spans that
 * start before the first anchor (a gateway span that opens the trace, say) join
 * turn 1 rather than becoming a turn of their own.
 */
export function buildSessionTurns(spans: readonly AiSessionSpan[]): readonly SessionTurn[] {
	if (spans.length === 0) return []

	// Decorate/sort/undecorate: one timestamp parse per span rather than one per
	// comparison.
	const ordered = spans
		.map((span) => ({ span, startMs: spanStartMs(span) }))
		.sort((a, b) => a.startMs - b.startMs)
	const anchors = findAnchors(ordered.map((entry) => entry.span))
	const anchorStarts = anchors.map((anchor) => spanStartMs(anchor.span))
	const buckets: AiSessionSpan[][] = anchors.map(() => [])

	// Both lists are in start order, so one forward cursor assigns every span.
	let cursor = 0
	for (const { span, startMs } of ordered) {
		while (cursor + 1 < anchors.length && anchorStarts[cursor + 1]! <= startMs) cursor++
		buckets[cursor]!.push(span)
	}

	// Two anchors starting in the same millisecond leave the earlier one's bucket
	// empty, and a turn with no spans has no start, no end and nothing to draw.
	return anchors
		.map((anchor, index) => ({ anchor, turnSpans: buckets[index]! }))
		.filter((entry) => entry.turnSpans.length > 0)
		.map(({ anchor, turnSpans }, index) => {
			const spanIds = new Set(turnSpans.map((span) => span.spanId))
			const startMs = Math.min(...turnSpans.map(spanStartMs))
			const endMs = Math.max(...turnSpans.map(spanEndMs))
			const traceIds: string[] = []
			for (const span of turnSpans) if (!traceIds.includes(span.traceId)) traceIds.push(span.traceId)

			return {
				id: anchor.id,
				index: index + 1,
				anchorKind: anchor.kind,
				anchor: anchor.span,
				label: turnLabel(anchor.span, turnSpans),
				agentName:
					anchor.span.genAi.agentName ?? turnSpans.find((s) => s.genAi.agentName)?.genAi.agentName,
				startMs,
				endMs,
				durationMs: endMs - startMs,
				spans: turnSpans,
				// Only AI spans that root the turn count: a retried inference that
				// errored and then succeeded is a retry, not a failed turn, and the
				// app's own errored HTTP span is not the agent failing.
				failed: turnSpans.some(
					(span) =>
						span.isAiSpan &&
						spanFailed(span) &&
						(span.parentSpanId === "" || !spanIds.has(span.parentSpanId)),
				),
				traceIds,
			}
		})
}

function findAnchors(ordered: readonly AiSessionSpan[]): readonly TurnAnchor[] {
	const byConversation = new Map<string, AiSessionSpan>()
	for (const span of ordered) {
		const conversationId = span.genAi.conversationId
		// Six vendors (flue, google_adk, mastra, microsoft_agent_framework,
		// openai_agents_sdk, pydantic_ai) derive `maple_ai.session.id` FROM
		// `gen_ai.conversation.id`, so for them the id names the session and
		// repeats on every span — a partition of one, not a turn key.
		if (conversationId === undefined || conversationId === span.sessionId) continue
		if (!byConversation.has(conversationId)) byConversation.set(conversationId, span)
	}
	if (byConversation.size > 1) {
		return [...byConversation].map(([conversationId, span]) => ({
			span,
			kind: "conversation" as const,
			id: `conversation:${conversationId}`,
		}))
	}

	const byId = new Map(ordered.map((span) => [span.spanId, span]))
	// Not "no parent in the session": the query returns the app's own spans too,
	// so the trace root is an HTTP or workflow span and every agent span has an
	// in-session parent. A turn opens where agent work starts, which is an agent
	// span with no AI span above it anywhere in the chain — any AI ancestor
	// disqualifies, not just an agent one, so a sub-agent invoked from inside a
	// tool or an inference span does not open a turn. That errs toward fewer
	// turns, which is the safe direction.
	const underAiSpan = (span: AiSessionSpan): boolean => {
		const seen = new Set<string>([span.spanId])
		let parent = byId.get(span.parentSpanId)
		while (parent !== undefined && !seen.has(parent.spanId)) {
			if (parent.isAiSpan) return true
			seen.add(parent.spanId)
			parent = byId.get(parent.parentSpanId)
		}
		return false
	}
	const agentRoots = ordered.filter(
		(span) => span.isAiSpan && classifyAiSpan(span) === "agent" && !underAiSpan(span),
	)
	if (agentRoots.length > 0) {
		return agentRoots.map((span) => ({ span, kind: "agent-root" as const, id: `span:${span.spanId}` }))
	}

	const byTrace = new Map<string, AiSessionSpan>()
	for (const span of ordered) if (!byTrace.has(span.traceId)) byTrace.set(span.traceId, span)
	return [...byTrace].map(([traceId, span]) => ({ span, kind: "trace" as const, id: `trace:${traceId}` }))
}

/**
 * The turn's label: the newest user message the turn captured.
 *
 * The anchor is asked first — on a `chat`-shaped span `gen_ai.input.messages`
 * is the whole history sent to the model, so a descendant several turns deep
 * still carries turn 1's opening prompt.
 */
function turnLabel(anchor: AiSessionSpan, turnSpans: readonly AiSessionSpan[]): string | undefined {
	const fromAnchor = lastUserMessageText(anchor.genAi.inputMessages)
	if (fromAnchor !== undefined) return fromAnchor
	for (const span of turnSpans) {
		const text = lastUserMessageText(span.genAi.inputMessages)
		if (text !== undefined) return text
	}
	return undefined
}

/** Longest turn label the page will render before eliding — a captured prompt
 *  can be tens of kilobytes, and the title is one line. */
const MAX_LABEL_LENGTH = 80

/**
 * The newest user text inside a `gen_ai.input.messages` value.
 *
 * The value is captured JSON whose exact shape belongs to the vendor, so this
 * walks it and gives up rather than guessing: the documented shape is
 * `[{ role, parts: [{ type: "text", content }] }]`, and vendors also emit the
 * content as a bare string. The LAST user entry is the prompt this call was
 * made for; the ones before it are the chat history. Message capture is opt-in
 * and off by default, so returning `undefined` is the ordinary case, not a
 * failure.
 */
function lastUserMessageText(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined
	for (let i = value.length - 1; i >= 0; i--) {
		const entry: unknown = value[i]
		if (!isRecord(entry) || entry.role !== "user") continue
		const text = messageText(entry.parts) ?? messageText(entry.content)
		if (text !== undefined) return text
	}
	return undefined
}

function messageText(value: unknown): string | undefined {
	if (typeof value === "string") return proseLine(value)
	if (!Array.isArray(value)) return undefined
	for (const part of value) {
		if (typeof part === "string") {
			const text = proseLine(part)
			if (text !== undefined) return text
		}
		if (!isRecord(part)) continue
		const content = typeof part.content === "string" ? part.content : part.text
		if (typeof content === "string") {
			const text = proseLine(content)
			if (text !== undefined) return text
		}
	}
	return undefined
}

/** The message's first non-empty line, collapsed to one line's worth of text. */
function proseLine(value: string): string | undefined {
	for (const rawLine of value.split("\n")) {
		const line = rawLine.trim().replace(/\s+/g, " ")
		if (line.length === 0) continue
		return line.length > MAX_LABEL_LENGTH ? `${line.slice(0, MAX_LABEL_LENGTH - 1)}…` : line
	}
	return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
