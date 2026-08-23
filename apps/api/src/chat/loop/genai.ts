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
 * Message and tool payloads are capped. A capped value stays valid JSON —
 * either whole oldest messages are dropped (count reported separately) or the
 * overflow is re-encoded as a JSON string of its own prefix — because the
 * read side parses these fields, and a hard byte-slice would trade a big
 * attribute for an unrenderable one.
 */
import { MAPLE_NATIVE_SESSION_ID_ATTR, MAPLE_NATIVE_TURN_ID_ATTR } from "@maple/domain/gen-ai"
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
 * meets real pressure — `MAX_REPLAYED_CHARS` alone admits 60k of text. Output
 * and tool payloads are already bounded upstream (model output limits,
 * `mcp/tools/tool-output.ts`); their caps are a backstop.
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

const messagesJson = (
	messages: ReadonlyArray<Message>,
	budget: number,
): { readonly json: string; readonly dropped: number } => {
	const rendered = messages.map(serializeMessage)
	// One serialization per message, so trimming to budget is a prefix-sum walk
	// rather than a re-stringify of the whole array per dropped message.
	const sizes = rendered.map((message) => JSON.stringify(message).length + 1)
	let total = sizes.reduce((sum, size) => sum + size, 1)
	let start = 0
	while (total > budget && start < rendered.length - 1) {
		total -= sizes[start]!
		start += 1
	}
	let json = JSON.stringify(start === 0 ? rendered : rendered.slice(start))
	// A single message can outweigh the whole budget; keep the value valid JSON
	// by re-encoding the prefix as a string rather than slicing mid-token.
	if (json.length > budget) json = JSON.stringify(json.slice(0, budget) + "…[truncated]")
	return { json, dropped: start }
}

/** Bounded JSON for tool arguments/results; never throws, never invalid JSON. */
const boundedJson = (value: unknown): string => {
	let json: string
	try {
		json = JSON.stringify(value) ?? "null"
	} catch {
		return JSON.stringify(String(value))
	}
	return json.length > TOOL_JSON_BUDGET
		? JSON.stringify(json.slice(0, TOOL_JSON_BUDGET) + "…[truncated]")
		: json
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
		...(input.dropped > 0 ? { "maple.genai.input_messages_dropped": input.dropped } : undefined),
		...identityAttributes(identity),
	}
}

/** The response half of a model-call span: finish reason, usage, output. */
export const annotateModelResponse = (response: LLMResponse): Effect.Effect<void> => {
	const usage = response.usage
	return Effect.annotateCurrentSpan({
		"gen_ai.response.finish_reasons": [response.finishReason],
		"gen_ai.output.messages": messagesJson([response.message], OUTPUT_MESSAGES_BUDGET).json,
		...(usage?.inputTokens === undefined ? undefined : { "gen_ai.usage.input_tokens": usage.inputTokens }),
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
}

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
				"gen_ai.tool.call.result": boundedJson(outcome.result.value),
				...(outcome.result.type === "error" ? { "error.type": "tool_error" } : undefined),
			}),
		),
		Effect.withSpan(`execute_tool ${call.name}`, {
			attributes: {
				"gen_ai.operation.name": "execute_tool",
				"gen_ai.tool.name": call.name,
				"gen_ai.tool.call.id": call.id,
				"gen_ai.tool.call.arguments": boundedJson(call.input),
				...identityAttributes(identity),
			},
		}),
	)
