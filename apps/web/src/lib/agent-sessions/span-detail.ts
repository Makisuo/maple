// What one expanded span can actually show: the captured messages and the
// tool calls — read from the span, never synthesised.
//
// `gen_ai.input.messages`, `gen_ai.output.messages` and
// `gen_ai.system_instructions` are captured JSON whose exact shape belongs to
// the vendor. The documented shape is `[{ role, parts: [{ type, ... }] }]`,
// and vendors also emit bare strings and `content` arrays, so everything here
// walks tolerantly and keeps what it cannot parse as raw JSON text rather
// than dropping it — a payload the reader cannot see is worse than one that
// is ugly. Nothing is invented: there are no per-message token counts or
// timestamps in the data, so none are returned, and a span that captured no
// messages yields an empty list, not a placeholder transcript.

import type { AiSessionSpan } from "@maple/domain/http"

export type SpanMessagePart =
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "tool_call"
			readonly id: string | undefined
			readonly name: string | undefined
			readonly argumentsText: string | undefined
	  }
	| { readonly kind: "tool_result"; readonly id: string | undefined; readonly resultText: string }
	/** Model reasoning, which is not assistant speech and must never read as it.
	 *  `text` is absent for a redacted block — the provider returned a sealed
	 *  blob, so there is nothing to show. */
	| { readonly kind: "reasoning"; readonly text: string | undefined; readonly redacted: boolean }

export interface SpanMessage {
	/** The captured role, verbatim — `user`, `assistant`, `system`, `tool`, … */
	readonly role: string
	/** Which attribute carried it; output messages are what this call produced. */
	readonly origin: "system" | "input" | "output"
	readonly parts: readonly SpanMessagePart[]
}

/**
 * Every message the span captured, in the order the model saw them: system
 * instructions first, then the input history, then what the call produced.
 */
export function spanMessages(span: AiSessionSpan): readonly SpanMessage[] {
	return [
		...systemMessages(span.genAi.systemInstructions),
		...parseMessages(span.genAi.inputMessages, "input"),
		...parseMessages(span.genAi.outputMessages, "output"),
	]
}

/** One tool invocation the span carries evidence of. */
export interface SpanToolCall {
	readonly name: string | undefined
	readonly id: string | undefined
	readonly description: string | undefined
	readonly argumentsText: string | undefined
	readonly resultText: string | undefined
	/**
	 * This span EXECUTED this call, rather than merely making it: the call came
	 * from the span's own `gen_ai.tool.*` attributes.
	 *
	 * It is the only call a reader may read the span's status against. A model
	 * span's output calls are its request — a model call that failed on
	 * `context_length_exceeded` says nothing about whether the tools it asked
	 * for ever ran, and colouring them red would claim it did.
	 */
	readonly own: boolean
}

/**
 * The tool calls this span is about: a tool-execution span's own
 * `gen_ai.tool.*` attributes, plus any `tool_call` parts in the messages this
 * call produced. Input-history tool calls are deliberately left out — they
 * belong to the earlier span that made them, and repeating them here would
 * count one call once per following request.
 *
 * A model span's output only ever *makes* its calls; what each returned is
 * captured elsewhere in the session. `results` (see `sessionToolResults`)
 * fills those in by call id, so a call and its response read together instead
 * of sending the reader off to open the tool spans one by one.
 */
export function spanToolCalls(span: AiSessionSpan, results?: SessionToolResults): readonly SpanToolCall[] {
	const calls: SpanToolCall[] = []
	const own = ownToolCall(span)
	if (own !== undefined) calls.push(withResolvedResult(own, span, results))

	for (const message of parseMessages(span.genAi.outputMessages, "output")) {
		for (const part of message.parts) {
			if (part.kind !== "tool_call") continue
			// The span's own attributes already describe this call.
			if (own !== undefined && part.id !== undefined && part.id === own.id) continue
			calls.push(
				withResolvedResult(
					{
						name: part.name,
						id: part.id,
						description: undefined,
						argumentsText: part.argumentsText,
						resultText: undefined,
						own: false,
					},
					span,
					results,
				),
			)
		}
	}
	return calls
}

/** The span's own evidence wins; the session index only fills an absence. */
function withResolvedResult(
	call: SpanToolCall,
	span: AiSessionSpan,
	results: SessionToolResults | undefined,
): SpanToolCall {
	if (call.resultText !== undefined || call.id === undefined) return call
	const resultText = toolResultFor(results, span.traceId, call.id)
	return resultText === undefined ? call : { ...call, resultText }
}

/**
 * Every captured tool result in the session, under two keys.
 *
 * Results come back as evidence on other spans than the calls that made them:
 * the tool-execution span's own `gen_ai.tool.call.result`, or a
 * `tool_call_response` part echoed into the input history of a later call.
 * Both are collected — the tool span's first-hand attribute wins over the
 * echo — and calls are matched strictly by id: nothing is paired by guesswork.
 *
 * Call ids are only unique within the run that issued them: two parallel lanes,
 * or a retry in a second trace, reuse `toolu_1` for different work. So every
 * result is indexed twice — once under `traceId\0callId` and once under the
 * bare id — and `toolResultFor` prefers the caller's own trace before falling
 * back to the session-wide answer.
 */
export function sessionToolResults(spans: readonly AiSessionSpan[]): SessionToolResults {
	const results = new Map<string, string>()
	const put = (traceId: string, id: string, text: string) => {
		const scoped = scopedResultKey(traceId, id)
		if (!results.has(scoped)) results.set(scoped, text)
		if (!results.has(id)) results.set(id, text)
	}
	for (const span of spans) {
		const own = ownToolCall(span)
		if (own?.id !== undefined && own.resultText !== undefined) put(span.traceId, own.id, own.resultText)
	}
	for (const span of spans) {
		for (const message of parseMessages(span.genAi.inputMessages, "input")) {
			for (const part of message.parts) {
				if (part.kind !== "tool_result" || part.id === undefined) continue
				// A `tool_call_response` carrying neither `response` nor `result` is an
				// echo of the call, not of its answer. Registering its empty text would
				// claim the id and block the real echo that follows.
				if (part.resultText === "") continue
				put(span.traceId, part.id, part.resultText)
			}
		}
	}
	return results
}

/** The index `sessionToolResults` builds — read it through `toolResultFor`. */
export type SessionToolResults = ReadonlyMap<string, string>

function scopedResultKey(traceId: string, id: string): string {
	// A separator no call id can contain, so a scoped key can never collide with
	// a bare one.
	return `${traceId}\u0000${id}`
}

/** The result for one call: the same trace's answer first, the session-wide one
 *  only where that trace never reported it. */
export function toolResultFor(
	results: SessionToolResults | undefined,
	traceId: string,
	id: string,
): string | undefined {
	return results?.get(scopedResultKey(traceId, id)) ?? results?.get(id)
}

function ownToolCall(span: AiSessionSpan): SpanToolCall | undefined {
	const { toolName, toolCallId, toolDescription } = span.genAi
	// Captured attributes decode through `Schema.Unknown`, so an emitter that
	// wrote JSON `null` lands here as `null` rather than as a missing key. Both
	// mean "not captured", and rendering the string "null" would invent a payload.
	const toolCallArguments = span.genAi.toolCallArguments ?? undefined
	const toolCallResult = span.genAi.toolCallResult ?? undefined
	if (
		toolName === undefined &&
		toolCallId === undefined &&
		toolCallArguments === undefined &&
		toolCallResult === undefined
	) {
		return undefined
	}
	return {
		name: toolName,
		id: toolCallId,
		description: toolDescription,
		argumentsText: toolCallArguments === undefined ? undefined : jsonText(toolCallArguments),
		resultText: toolCallResult === undefined ? undefined : jsonText(toolCallResult),
		own: true,
	}
}

/** Captured values are decoded JSON by the time they reach the client, so a
 *  display string re-serialises; the raw string case is already the payload. */
export function jsonText(value: unknown): string {
	if (typeof value === "string") return value
	const text = JSON.stringify(value)
	return text === undefined ? String(value) : text
}

/* -------------------------------------------------------------------------- */
/* Message walking                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Part types that carry model reasoning rather than assistant speech.
 * `reasoning` is the semconv name; `thinking` / `redacted_thinking` are
 * Anthropic's wire types, which several SDKs pass through verbatim. Without
 * this, a thinking part renders as prose the model never said.
 */
const REASONING_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"])

/**
 * `gen_ai.system_instructions` is documented as an array of parts with no
 * role; vendors also emit a bare string or full role-carrying messages.
 */
function systemMessages(value: unknown): readonly SpanMessage[] {
	if (value === undefined || value === null) return []
	if (typeof value === "string") {
		return value.trim() === ""
			? []
			: [{ role: "system", origin: "system", parts: [{ kind: "text", text: value }] }]
	}
	if (!Array.isArray(value)) {
		return [{ role: "system", origin: "system", parts: [rawPart(value)] }]
	}
	// Entries carrying roles are messages; otherwise the array is one
	// message's parts.
	if (value.some((entry) => isRecord(entry) && typeof entry.role === "string")) {
		return parseMessages(value, "system")
	}
	const parts = value.map(parsePart)
	return parts.length === 0 ? [] : [{ role: "system", origin: "system", parts }]
}

function parseMessages(value: unknown, origin: SpanMessage["origin"]): readonly SpanMessage[] {
	if (value === undefined || value === null) return []
	if (!Array.isArray(value)) {
		if (typeof value === "string" && value.trim() === "") return []
		return [{ role: origin === "output" ? "assistant" : "user", origin, parts: [rawPart(value)] }]
	}

	const messages: SpanMessage[] = []
	for (const entry of value) {
		if (!isRecord(entry)) {
			messages.push({
				role: origin === "output" ? "assistant" : "user",
				origin,
				parts: [rawPart(entry)],
			})
			continue
		}
		const role =
			typeof entry.role === "string" && entry.role !== ""
				? entry.role
				: origin === "output"
					? "assistant"
					: "user"
		const parts = messageParts(entry)
		if (parts.length === 0) continue
		messages.push({ role, origin, parts })
	}
	return messages
}

function messageParts(message: Record<string, unknown>): readonly SpanMessagePart[] {
	const source = message.parts ?? message.content
	if (typeof source === "string") return source === "" ? [] : [{ kind: "text", text: source }]
	if (!Array.isArray(source)) {
		return source === undefined || source === null ? [] : [rawPart(source)]
	}
	return source.map(parsePart)
}

function parsePart(part: unknown): SpanMessagePart {
	if (typeof part === "string") return { kind: "text", text: part }
	if (!isRecord(part)) return rawPart(part)

	const type = typeof part.type === "string" ? part.type : undefined
	if (type === "tool_call") {
		return {
			kind: "tool_call",
			id: stringOrUndefined(part.id),
			name: stringOrUndefined(part.name),
			argumentsText: part.arguments === undefined ? undefined : jsonText(part.arguments),
		}
	}
	if (type === "tool_call_response") {
		return {
			kind: "tool_result",
			id: stringOrUndefined(part.id),
			// Semconv names it `response`; Maple's own emitter writes `result`.
			resultText: jsonText(part.response ?? part.result ?? ""),
		}
	}
	if (type !== undefined && REASONING_TYPES.has(type)) {
		// Anthropic seals a redacted block behind `data` with no readable text;
		// labelling it is the whole of what can be said about it.
		if (type === "redacted_thinking") return { kind: "reasoning", text: undefined, redacted: true }
		return { kind: "reasoning", text: reasoningText(part), redacted: false }
	}

	// `{type: "text", content}` per the semconv, plus the `text` key vendors use.
	const text = part.content ?? part.text
	if (typeof text === "string") return { kind: "text", text }
	return rawPart(part)
}

/**
 * A reasoning block's readable text.
 *
 * `text` is the semconv key, `thinking` Anthropic's, and `content` is what
 * SDKs that reuse the message shape write — which means it can also be a BLOCK
 * ARRAY rather than a string. The module's contract is that nothing captured is
 * ever dropped, so a non-string payload is walked when it is plainly
 * text-bearing and kept as its own JSON when it is not; only a genuinely absent
 * or empty value yields `undefined`.
 */
function reasoningText(part: Record<string, unknown>): string | undefined {
	const value = part.text ?? part.content ?? part.thinking
	if (value === undefined || value === null) return undefined
	const text = typeof value === "string" ? value : blockText(value)
	return text === "" ? undefined : text
}

function blockText(value: unknown): string {
	if (!Array.isArray(value)) return jsonText(value)
	return value
		.map((block) => {
			const part = parsePart(block)
			return part.kind === "text" ? part.text : jsonText(block)
		})
		.join("\n")
}

/** A shape this walker does not know stays visible as its own JSON. */
function rawPart(value: unknown): SpanMessagePart {
	return { kind: "text", text: jsonText(value) }
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
