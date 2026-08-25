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
export function spanToolCalls(
	span: AiSessionSpan,
	results?: ReadonlyMap<string, string>,
): readonly SpanToolCall[] {
	const calls: SpanToolCall[] = []
	const own = ownToolCall(span)
	if (own !== undefined) calls.push(withResolvedResult(own, results))

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
					},
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
	results: ReadonlyMap<string, string> | undefined,
): SpanToolCall {
	if (call.resultText !== undefined || call.id === undefined) return call
	const resultText = results?.get(call.id)
	return resultText === undefined ? call : { ...call, resultText }
}

/**
 * Every captured tool result in the session, by tool call id.
 *
 * Results come back as evidence on other spans than the calls that made them:
 * the tool-execution span's own `gen_ai.tool.call.result`, or a
 * `tool_call_response` part echoed into the input history of a later call.
 * Both are collected — the tool span's first-hand attribute wins over the
 * echo — and calls are matched strictly by id: nothing is paired by guesswork.
 */
export function sessionToolResults(spans: readonly AiSessionSpan[]): ReadonlyMap<string, string> {
	const results = new Map<string, string>()
	for (const span of spans) {
		const own = ownToolCall(span)
		if (own?.id !== undefined && own.resultText !== undefined) results.set(own.id, own.resultText)
	}
	for (const span of spans) {
		for (const message of parseMessages(span.genAi.inputMessages, "input")) {
			for (const part of message.parts) {
				if (part.kind !== "tool_result" || part.id === undefined) continue
				if (!results.has(part.id)) results.set(part.id, part.resultText)
			}
		}
	}
	return results
}

function ownToolCall(span: AiSessionSpan): SpanToolCall | undefined {
	const { toolName, toolCallId, toolDescription, toolCallArguments, toolCallResult } = span.genAi
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
	}
}

/** Captured values are decoded JSON by the time they reach the client, so a
 *  display string re-serialises; the raw string case is already the payload. */
function jsonText(value: unknown): string {
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
		const reasoning = part.text ?? part.content ?? part.thinking
		return {
			kind: "reasoning",
			text: typeof reasoning === "string" && reasoning !== "" ? reasoning : undefined,
			redacted: false,
		}
	}

	// `{type: "text", content}` per the semconv, plus the `text` key vendors use.
	const text = part.content ?? part.text
	if (typeof text === "string") return { kind: "text", text }
	return rawPart(part)
}

/** A shape this walker does not know stays visible as its own JSON. */
function rawPart(value: unknown): SpanMessagePart {
	return { kind: "text", text: jsonText(value) }
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
