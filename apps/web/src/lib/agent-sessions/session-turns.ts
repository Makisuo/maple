// Session structure: what a span is, and where one turn ends and the next begins.
//
// A session arrives as a flat list of spans drawn from several traces and
// services, and the detail page's whole value is recovering the shape of the
// conversation that produced them. No framework records "this is turn 4", so
// every rule below is a heuristic over the OTel gen_ai attributes — which is
// exactly why they live here, named and commented, instead of inside the
// components that render them.

import type { AiSessionSpan } from "@maple/domain/http"
import { toEpochMs } from "@maple/ui/lib/time-format"

/**
 * How a span reads on the page. Deliberately coarse — these four are the
 * distinctions the waterfall colors, the occupancy bar splits on, and the work
 * counters tally, and nothing else needs a finer taxonomy.
 */
export type SpanCategory = "agent" | "inference" | "tool" | "other"

// `gen_ai.operation.name` is an open set (see AI_KNOWN_OPERATION_NAMES in
// @maple/query-engine-integrations), so these group the documented values and
// an unknown one falls through to the span-name rules below rather than being
// rejected.
const INFERENCE_OPS = new Set(["chat", "generate_content", "text_completion", "fetch_response"])
/** Inference-shaped work that is not a chat completion: counted as inference
 *  occupancy, never as an "llm call" — an embedding is not a model turn. */
const RETRIEVAL_OPS = new Set(["embeddings", "retrieval"])
const TOOL_OPS = new Set(["execute_tool"])
// `agent_step` is Vercel AI SDK's, not the convention's, and already appears in
// production data.
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

export function classifySpan(span: AiSessionSpan): SpanCategory {
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
 * Everything else `classifySpan` reads as inference counts, including the
 * open-set operation names vendors invent (`generate_text`): matching only the
 * documented four would color a span as inference and then leave it out of the
 * call count, the model rows and the token column.
 */
export function isLlmCall(span: AiSessionSpan): boolean {
	const operation = span.genAi.operationName
	if (operation !== undefined && RETRIEVAL_OPS.has(operation)) return false
	return classifySpan(span) === "inference"
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

/** Which rule produced a turn boundary — the header reads this to tell a
 *  session that ended from one that was simply abandoned mid-flight. */
export type TurnAnchorKind = "conversation" | "agent-root" | "trace"

export interface SessionTurn {
	readonly id: string
	/** 1-based, in start order — the `TURN n` the page prints. */
	readonly index: number
	readonly anchorKind: TurnAnchorKind
	/** The span that opened the turn. */
	readonly anchor: AiSessionSpan
	/** The turn's opening user message, when the vendor captured message content. */
	readonly label: string | undefined
	readonly agentName: string | undefined
	readonly startMs: number
	readonly endMs: number
	readonly durationMs: number
	/** Every span of the turn, in start order. */
	readonly spans: readonly AiSessionSpan[]
	/** A span that roots the turn ended `Error` — the turn did not close cleanly. */
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
 *    one eve stamps with its turn id. One id, one turn, but only where the ids
 *    actually partition the session (see `findAnchors`).
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

	const ordered = [...spans].sort((a, b) => spanStartMs(a) - spanStartMs(b))
	const anchors = findAnchors(ordered)
	const buckets: AiSessionSpan[][] = anchors.map(() => [])

	// Both lists are in start order, so one forward cursor assigns every span.
	let cursor = 0
	for (const span of ordered) {
		const start = spanStartMs(span)
		while (cursor + 1 < anchors.length && spanStartMs(anchors[cursor + 1]!.span) <= start) cursor++
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
				label: turnLabel(turnSpans),
				agentName:
					anchor.span.genAi.agentName ?? turnSpans.find((s) => s.genAi.agentName)?.genAi.agentName,
				startMs,
				endMs,
				durationMs: endMs - startMs,
				spans: turnSpans,
				// Only spans that root the turn count: a retried inference that errored
				// and then succeeded is a retry, not a failed turn.
				failed: turnSpans.some(
					(span) =>
						span.statusCode === "Error" &&
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
	// span with no agent work above it anywhere in the chain.
	const underAgent = (span: AiSessionSpan): boolean => {
		const seen = new Set<string>([span.spanId])
		let parent = byId.get(span.parentSpanId)
		while (parent !== undefined && !seen.has(parent.spanId)) {
			if (parent.isAiSpan || classifySpan(parent) === "agent") return true
			seen.add(parent.spanId)
			parent = byId.get(parent.parentSpanId)
		}
		return false
	}
	const agentRoots = ordered.filter(
		(span) => span.isAiSpan && classifySpan(span) === "agent" && !underAgent(span),
	)
	if (agentRoots.length > 0) {
		return agentRoots.map((span) => ({ span, kind: "agent-root" as const, id: `span:${span.spanId}` }))
	}

	const byTrace = new Map<string, AiSessionSpan>()
	for (const span of ordered) if (!byTrace.has(span.traceId)) byTrace.set(span.traceId, span)
	return [...byTrace].map(([traceId, span]) => ({ span, kind: "trace" as const, id: `trace:${traceId}` }))
}

function turnLabel(turnSpans: readonly AiSessionSpan[]): string | undefined {
	for (const span of turnSpans) {
		const text = firstUserMessageText(span.genAi.inputMessages)
		if (text !== undefined) return text
	}
	return undefined
}

/** Longest turn label the page will render before eliding — a captured prompt
 *  can be tens of kilobytes, and the title is one line. */
const MAX_LABEL_LENGTH = 80

// Frameworks prepend pseudo-XML context blocks to the user's message
// (`<current_time>…</current_time>`, `<slack_channel_context>…`). They are
// identical on every turn, so a label taken from one names nothing — it would
// print the same title above the session and the same row on all eight turns.
const TAG_BLOCK = /<([a-z_][\w.-]*)\b[^>]*>[\s\S]*?<\/\1>/gi
const ORPHAN_TAG = /<\/?[a-z_][\w.-]*\b[^>]*>/gi
// What survives the blocks is often injected metadata rather than prose: a
// single `key: value` with no sentence around it.
const KEY_VALUE_LINE = /^[\w .-]{1,32}:\s*\S*$/

/**
 * The first user text inside a `gen_ai.input.messages` value.
 *
 * The value is captured JSON whose exact shape belongs to the vendor, so this
 * walks it and gives up rather than guessing: the documented shape is
 * `[{ role, parts: [{ type: "text", content }] }]`, and vendors also emit the
 * content as a bare string. Message capture is opt-in and off by default, so
 * returning `undefined` is the ordinary case, not a failure.
 */
export function firstUserMessageText(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined
	for (const entry of value) {
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

/**
 * The first line of a captured message that reads as something a person wrote.
 *
 * Injected context is dropped rather than truncated, and a message that is only
 * injected context has no label at all — the callers' fallbacks (the agent name
 * and start time for the title, "no captured message" for a turn row) say more
 * than `<current_time>2026-08-…` would.
 */
function proseLine(value: string): string | undefined {
	const stripped = value.replace(TAG_BLOCK, "\n").replace(ORPHAN_TAG, "\n")
	for (const rawLine of stripped.split("\n")) {
		const line = rawLine.trim().replace(/\s+/g, " ")
		if (line.length === 0 || !/\p{L}/u.test(line) || KEY_VALUE_LINE.test(line)) continue
		return line.length > MAX_LABEL_LENGTH ? `${line.slice(0, MAX_LABEL_LENGTH - 1)}…` : line
	}
	return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
