/**
 * Gen-AI semconv spans for Maple's own agents — self-instrumentation, so an
 * investigation or chat shows up in Agent Sessions like any customer's agent.
 *
 * The contract has two halves:
 *
 *   - **Canonical `gen_ai.*` attributes** (`AI_GENAI_FIELDS` in
 *     `@maple/domain/gen-ai`) carry what happened: operation, model, token
 *     usage, messages, tool calls. The read-side default integration decodes
 *     them with no per-vendor mapping.
 *   - **`maple.session.id` / `maple.turn.id`** carry where it belongs. The
 *     ingest gateway's `maple` vendor (see `apps/ingest/src/ai_session.rs`)
 *     detects on the session key and lifts it into `maple_ai.session.id` — the
 *     attribute that actually groups traces into a session. Without it, spans
 *     land in the gateway's unknown tier, where no session is ever stamped.
 *     Mirrors how eve rides `eve.session.id` / `eve.turn.id`.
 *
 * Every attribute goes on **every** gen-ai span, not just the turn root: the
 * session *list* groups whole traces off one stamped span, but the detail view
 * fans out by `maple_ai.session.id = ?`, so an unstamped span is invisible
 * there.
 *
 * Message and tool payloads are capped. A capped value keeps its *shape*, not
 * just JSON validity: the read side's `json` decoder admits objects and arrays
 * only, so degrading an over-budget value to a JSON string would make the
 * attribute vanish rather than render truncated. Message lists drop whole
 * oldest messages first (count reported separately), then truncate oversized
 * part payloads in place; tool values are wrapped and truncated as objects.
 */
import {
	MAPLE_GENAI_INPUT_MESSAGES_DROPPED_ATTR,
	MAPLE_NATIVE_SESSION_ID_ATTR,
	MAPLE_NATIVE_TURN_ID_ATTR,
} from "@maple/domain/gen-ai"
import { LLMResponse, type LLMEvent, type Message, type Model } from "@maple/llm"
import { Effect } from "effect"
import type { ChatTurnInput } from "./types"

/** The two grouping ids every gen-ai span carries. */
export interface GenAiIdentity {
	readonly sessionId: string
	readonly turnId: string
}

/**
 * The identity a turn's spans are stamped with.
 *
 * `sessionId` is usually the chat session id itself; a headless investigation
 * pass overrides it (`genAiSessionId`) because its `sessionId` is a per-pass
 * correlation id, while all of its passes belong to one investigation session.
 */
export const genAiIdentityOf = (input: ChatTurnInput): GenAiIdentity => ({
	sessionId: input.genAiSessionId ?? input.sessionId,
	turnId: input.messageId,
})

const identityAttributes = (identity: GenAiIdentity): Record<string, unknown> => ({
	[MAPLE_NATIVE_SESSION_ID_ATTR]: identity.sessionId,
	[MAPLE_NATIVE_TURN_ID_ATTR]: identity.turnId,
})

/**
 * Per-attribute size budgets, in JSON characters.
 *
 * Input messages replay the whole transcript each step, so this is the one that
 * meets real pressure — `MAX_REPLAYED_CHARS` alone admits 60k of text. The tool
 * budget is the *primary* limiter for tool results, not a backstop: upstream
 * bounds them at `MAX_TOOL_OUTPUT_BYTES` (50k, `mcp/tools/tool-output.ts`),
 * six times this cap, so large query output truncates here routinely.
 */
const INPUT_MESSAGES_BUDGET = 20_000
const OUTPUT_MESSAGES_BUDGET = 8_000
const TOOL_JSON_BUDGET = 8_000

type SerializedPart =
	| { readonly type: "text"; readonly content: string }
	| { readonly type: "tool_call"; readonly id: string; readonly name: string; readonly arguments: unknown }
	| { readonly type: "tool_call_response"; readonly id: string; readonly result: unknown }

/**
 * Semconv-shaped message projection: `{ role, parts }`, the format
 * `gen_ai.input.messages` / `gen_ai.output.messages` document. Media parts are
 * size, and reasoning parts are provider-hidden thought — neither is the
 * conversation, so both are dropped.
 */
const serializeMessage = (message: Message): { role: string; parts: Array<SerializedPart> } => ({
	role: message.role,
	parts: message.content.flatMap((part): Array<SerializedPart> => {
		switch (part.type) {
			case "text":
				return part.text === "" ? [] : [{ type: "text", content: part.text }]
			case "tool-call":
				return [{ type: "tool_call", id: part.id, name: part.name, arguments: part.input }]
			case "tool-result":
				return [{ type: "tool_call_response", id: part.id, result: part.result.value }]
			default:
				return []
		}
	}),
})

const TRUNCATION_MARKER = "…[truncated]"

const truncated = (text: string, cap: number): string =>
	text.length > cap ? text.slice(0, cap) + TRUNCATION_MARKER : text

/** The payload's JSON prefix as a string when it outweighs `cap`, or nothing
 *  when the payload fits and can ride along unchanged. */
const oversizedPayloadPrefix = (value: unknown, cap: number): string | undefined => {
	let json: string
	try {
		json = JSON.stringify(value) ?? "null"
	} catch {
		return truncated(String(value), cap)
	}
	return json.length > cap ? json.slice(0, cap) + TRUNCATION_MARKER : undefined
}

const boundPart = (part: SerializedPart, cap: number): SerializedPart => {
	switch (part.type) {
		case "text":
			return part.content.length > cap ? { ...part, content: truncated(part.content, cap) } : part
		case "tool_call": {
			const prefix = oversizedPayloadPrefix(part.arguments, cap)
			return prefix === undefined ? part : { ...part, arguments: prefix }
		}
		case "tool_call_response": {
			const prefix = oversizedPayloadPrefix(part.result, cap)
			return prefix === undefined ? part : { ...part, result: prefix }
		}
	}
}

/** First message the encoded list can start at and still fit the budget —
 *  except the newest message, which is never dropped. */
const fitFrom = (encoded: ReadonlyArray<string>, budget: number): number => {
	let total = encoded.reduce((sum, json) => sum + json.length + 1, 1)
	let start = 0
	while (total > budget && start < encoded.length - 1) {
		total -= encoded[start]!.length + 1
		start += 1
	}
	return start
}

const messagesJson = (
	messages: ReadonlyArray<Message>,
	budget: number,
): { readonly json: string; readonly dropped: number } => {
	let rendered = messages.map(serializeMessage)
	// One serialization per message, so trimming to budget is a prefix-sum walk
	// rather than a re-stringify of the whole array per dropped message.
	let encoded = rendered.map((message) => JSON.stringify(message))
	let start = fitFrom(encoded, budget)
	// A single message can outweigh the whole budget — routinely, since a tool
	// result may run to 50k against the 20k input cap. Bound each surviving
	// part's payload and re-fit; the attribute stays the array of messages the
	// read side decodes, just with truncated payloads inside. (The per-part cap
	// makes this a soft budget: JSON escaping and a message with many parts can
	// overshoot it, bounded, which beats losing the attribute.)
	if (encoded.slice(start).reduce((sum, json) => sum + json.length + 1, 1) > budget) {
		const cap = Math.max(256, Math.floor(budget / 8))
		rendered = rendered.map((message, index) =>
			index < start ? message : { ...message, parts: message.parts.map((part) => boundPart(part, cap)) },
		)
		encoded = rendered.map((message) => JSON.stringify(message))
		start = fitFrom(encoded, budget)
	}
	return { json: `[${encoded.slice(start).join(",")}]`, dropped: start }
}

/**
 * Bounded JSON for tool arguments/results; never throws, and always an object
 * or array — the read side's `json` decoder drops scalar values, and Maple's
 * own tool results are strings, so a bare value would never render.
 *
 * Exported for tests.
 */
export const toolCallJson = (value: unknown): string => {
	const wrapped = typeof value === "object" && value !== null ? value : { result: value }
	let json: string
	try {
		json = JSON.stringify(wrapped) ?? "{}"
	} catch {
		return JSON.stringify({ result: truncated(String(value), TOOL_JSON_BUDGET) })
	}
	if (json.length <= TOOL_JSON_BUDGET) return json
	let prefix = json.slice(0, TOOL_JSON_BUDGET)
	let out = JSON.stringify({ truncated: true, prefix })
	if (out.length > TOOL_JSON_BUDGET) {
		// Re-encoding escapes quotes and backslashes, expanding the prefix; one
		// corrective re-slice by the measured excess holds the cap, since every
		// removed input character removes at least one output character.
		prefix = prefix.slice(0, Math.max(0, prefix.length - (out.length - TOOL_JSON_BUDGET)))
		out = JSON.stringify({ truncated: true, prefix })
	}
	return out
}

/** Semconv span name: `{operation} {target}`. */
export const invokeAgentSpanName = (agentName: string): string => `invoke_agent ${agentName}`

export const invokeAgentAttributes = (
	agentName: string,
	model: Model,
	identity: GenAiIdentity,
): Record<string, unknown> => ({
	"gen_ai.operation.name": "invoke_agent",
	"gen_ai.agent.name": agentName,
	"gen_ai.provider.name": String(model.provider),
	"gen_ai.request.model": String(model.id),
	...identityAttributes(identity),
})

export const modelCallSpanName = (model: Model): string => `chat ${String(model.id)}`

/** Attributes known at request time; the response half arrives via {@link annotateModelResponse}. */
export const modelCallAttributes = (
	model: Model,
	messages: ReadonlyArray<Message>,
	identity: GenAiIdentity,
): Record<string, unknown> => {
	const input = messagesJson(messages, INPUT_MESSAGES_BUDGET)
	return {
		"gen_ai.operation.name": "chat",
		"gen_ai.provider.name": String(model.provider),
		"gen_ai.request.model": String(model.id),
		"gen_ai.input.messages": input.json,
		...(input.dropped > 0 ? { [MAPLE_GENAI_INPUT_MESSAGES_DROPPED_ATTR]: input.dropped } : undefined),
		...identityAttributes(identity),
	}
}

/**
 * `@maple/llm` finish reasons hyphenate; the read side's vocabulary is the
 * semconv underscore form (`REFUSAL_FINISH_REASONS` matches `content_filter`,
 * the default integration normalises `tool_calls`). Exported for tests.
 */
export const semconvFinishReason = (reason: string): string =>
	reason === "tool-calls" ? "tool_calls" : reason === "content-filter" ? "content_filter" : reason

/** The response half of a model-call span: finish reason, usage, output. */
export const annotateModelResponse = (response: LLMResponse): Effect.Effect<void> =>
	// Suspended so building the attribute record — which serializes the output
	// message — happens inside the returned Effect, not at call-site evaluation.
	Effect.suspend(() => {
		const usage = response.usage
		return Effect.annotateCurrentSpan({
			"gen_ai.response.finish_reasons": [semconvFinishReason(response.finishReason)],
			// A provider failure surfaced as a stream *event* completes the stream,
			// so the span exit stays green — this attribute is the record of it.
			...(response.finishReason === "error" ? { "error.type": "provider_error" } : undefined),
			"gen_ai.output.messages": messagesJson([response.message], OUTPUT_MESSAGES_BUDGET).json,
			...(usage?.inputTokens === undefined
				? undefined
				: { "gen_ai.usage.input_tokens": usage.inputTokens }),
			...(usage?.outputTokens === undefined
				? undefined
				: { "gen_ai.usage.output_tokens": usage.outputTokens }),
			...(usage?.cacheReadInputTokens === undefined
				? undefined
				: { "gen_ai.usage.cache_read.input_tokens": usage.cacheReadInputTokens }),
			...(usage?.cacheWriteInputTokens === undefined
				? undefined
				: { "gen_ai.usage.cache_creation.input_tokens": usage.cacheWriteInputTokens }),
			...(usage?.reasoningTokens === undefined
				? undefined
				: { "gen_ai.usage.reasoning.output_tokens": usage.reasoningTokens }),
		})
	})

/**
 * Annotate the current model-call span from the events collected so far.
 * Called on the stream's terminal event, when `events` can fold into a
 * completed response; a stream that dies earlier leaves the span with its
 * request attributes and the error exit, which is the honest record.
 */
export const annotateModelCallEnd = (events: ReadonlyArray<LLMEvent>): Effect.Effect<void> =>
	Effect.suspend(() => {
		const response = LLMResponse.fromEvents(events)
		return response ? annotateModelResponse(response) : Effect.void
	})

/**
 * Wrap one tool dispatch in an `execute_tool` span. The result is annotated
 * before `Effect.withSpan` closes the span, so both halves land on it.
 */
export const withToolCallSpan = <
	A extends { readonly result: { readonly type: string; readonly value: unknown } },
	E,
	R,
>(
	call: { readonly id: string; readonly name: string; readonly input: unknown },
	identity: GenAiIdentity,
	dispatch: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	dispatch.pipe(
		Effect.tap((outcome) =>
			Effect.annotateCurrentSpan({
				"gen_ai.tool.call.result": toolCallJson(outcome.result.value),
				...(outcome.result.type === "error" ? { "error.type": "tool_error" } : undefined),
			}),
		),
		Effect.withSpan(`execute_tool ${call.name}`, {
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": call.name,
				"gen_ai.tool.call.id": call.id,
				"gen_ai.tool.call.arguments": toolCallJson(call.input),
				...identityAttributes(identity),
			},
		}),
	)
