// What one expanded span can actually show: the captured messages, the tool
// calls, and the decoded attributes — read from the span, never synthesised.
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
import { AI_GENAI_FIELDS, type AiGenAiField } from "@maple/domain/gen-ai"

export type SpanMessagePart =
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "tool_call"
			readonly id: string | undefined
			readonly name: string | undefined
			readonly argumentsText: string | undefined
	  }
	| { readonly kind: "tool_result"; readonly id: string | undefined; readonly resultText: string }

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
 */
export function spanToolCalls(span: AiSessionSpan): readonly SpanToolCall[] {
	const calls: SpanToolCall[] = []
	const own = ownToolCall(span)
	if (own !== undefined) calls.push(own)

	for (const message of parseMessages(span.genAi.outputMessages, "output")) {
		for (const part of message.parts) {
			if (part.kind !== "tool_call") continue
			// The span's own attributes already describe this call.
			if (own !== undefined && part.id !== undefined && part.id === own.id) continue
			calls.push({
				name: part.name,
				id: part.id,
				description: undefined,
				argumentsText: part.argumentsText,
				resultText: undefined,
			})
		}
	}
	return calls
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

export interface SpanAttributeEntry {
	/** The semconv key (`gen_ai.usage.input_tokens`), not the decoded field name. */
	readonly key: string
	readonly value: string
}

/**
 * The decoded `gen_ai.*` values present on the span, under their semconv
 * keys, in catalog order. This is the decoded view the endpoint returns — the
 * raw attribute maps stay server-side, and the full span lives one
 * "Open in Traces" click away.
 */
export function spanAttributeEntries(span: AiSessionSpan): readonly SpanAttributeEntry[] {
	const entries: SpanAttributeEntry[] = []
	for (const field of Object.keys(AI_GENAI_FIELDS) as readonly AiGenAiField[]) {
		const value = span.genAi[field]
		if (value === undefined) continue
		entries.push({ key: AI_GENAI_FIELDS[field].key, value: attributeText(value) })
	}
	return entries
}

function attributeText(value: unknown): string {
	if (typeof value === "string") return value
	if (typeof value === "number" || typeof value === "boolean") return String(value)
	return jsonText(value)
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
			resultText: jsonText(part.response ?? part.result ?? ""),
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
