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
	MAPLE_GENAI_MODEL_DURATION_MS_ATTR,
	MAPLE_NATIVE_SESSION_ID_ATTR,
	MAPLE_NATIVE_TURN_ID_ATTR,
} from "@maple/domain/gen-ai"
import {
	LLMResponse,
	type LLMEvent,
	type LLMRequest,
	type Message,
	type Model,
	type SystemPart,
	type ToolDefinition,
} from "@maple/llm"
import { Clock, Effect } from "effect"
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
const SYSTEM_INSTRUCTIONS_BUDGET = 8_000
const TOOL_DEFINITIONS_BUDGET = 16_000
const AGENT_DESCRIPTION_BUDGET = 1_024

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
			index < start
				? message
				: { ...message, parts: message.parts.map((part) => boundPart(part, cap)) },
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

/**
 * Semconv-shaped `gen_ai.tool.definitions`: `[{type, name, description,
 * parameters}]`. Schemas are the bulk, so over budget they are the first thing
 * dropped — names and truncated descriptions are what the session view needs.
 * The compact form is a soft bound (many tools with long names can still
 * exceed it), which beats degrading to a shape the read side cannot decode.
 */
const toolDefinitionsJson = (tools: ReadonlyArray<ToolDefinition>): string => {
	const full = tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.inputSchema,
	}))
	// `inputSchema` is customer MCP-server data; a stringify throw here would be
	// a turn-killing defect (evaluated inside `Effect.sync`), so it degrades to
	// the compact form instead, like this file's other serializers.
	let json: string | undefined
	try {
		json = JSON.stringify(full)
	} catch {
		json = undefined
	}
	if (json !== undefined && json.length <= TOOL_DEFINITIONS_BUDGET) return json
	// 128 keeps the chat agent's real toolbox (~60 MCP tools) inside the budget;
	// the first sentence of a tool description is the part that identifies it.
	return JSON.stringify(
		tools.map((tool) => ({
			type: "function",
			name: tool.name,
			description: truncated(tool.description, 128),
		})),
	)
}

export const invokeAgentAttributes = (
	agent: { readonly name: string; readonly description?: string },
	model: Model,
	identity: GenAiIdentity,
	options: {
		readonly tools?: ReadonlyArray<ToolDefinition>
		/** Names the workflow the turn runs inside (`investigation`); attended chat has none. */
		readonly workflowName?: string
	} = {},
): Record<string, unknown> => ({
	"gen_ai.operation.name": "invoke_agent",
	"gen_ai.agent.name": agent.name,
	// Bounded: hypothesis agents put planner-written text here, the one
	// description with no length guarantee.
	...(agent.description === undefined || agent.description === ""
		? undefined
		: { "gen_ai.agent.description": truncated(agent.description, AGENT_DESCRIPTION_BUDGET) }),
	...(options.workflowName === undefined ? undefined : { "gen_ai.workflow.name": options.workflowName }),
	"gen_ai.provider.name": String(model.provider),
	"gen_ai.request.model": String(model.id),
	...(options.tools === undefined || options.tools.length === 0
		? undefined
		: { "gen_ai.tool.definitions": toolDefinitionsJson(options.tools) }),
	...identityAttributes(identity),
})

export const modelCallSpanName = (model: Model): string => `chat ${String(model.id)}`

/**
 * Semconv-shaped `gen_ai.system_instructions`: an array of `{type, content}`
 * parts, bounded like the message lists (an agent system prompt can run long,
 * and a degraded string would vanish at the read side's json decoder).
 */
const systemInstructionsJson = (system: ReadonlyArray<SystemPart>): string => {
	const parts = system.map((part) => ({ type: "text", content: part.text }))
	const json = JSON.stringify(parts)
	if (json.length <= SYSTEM_INSTRUCTIONS_BUDGET) return json
	const cap = Math.max(256, Math.floor(SYSTEM_INSTRUCTIONS_BUDGET / parts.length))
	return JSON.stringify(parts.map((part) => ({ ...part, content: truncated(part.content, cap) })))
}

/**
 * The OpenRouter reasoning effort this call runs with — the request's own
 * options first, then the model defaults the route client merges underneath
 * them (`resolveRequestOptions`), which is where `withReasoning` puts the
 * per-stage policy.
 */
const requestReasoningLevel = (request: LLMRequest): string | undefined => {
	const effort = (options: unknown): string | undefined => {
		if (typeof options !== "object" || options === null) return undefined
		const reasoning = (options as { readonly reasoning?: unknown }).reasoning
		if (typeof reasoning !== "object" || reasoning === null) return undefined
		const level = (reasoning as { readonly effort?: unknown }).effort
		return typeof level === "string" && level !== "" ? level : undefined
	}
	return (
		effort(request.providerOptions?.["openrouter"]) ??
		effort(request.model.defaults?.providerOptions?.["openrouter"])
	)
}

/** Attributes known at request time; the response half arrives via {@link annotateModelResponse}. */
export const modelCallAttributes = (
	request: LLMRequest,
	identity: GenAiIdentity,
	options: { readonly stream: boolean },
): Record<string, unknown> => {
	const input = messagesJson(request.messages, INPUT_MESSAGES_BUDGET)
	const reasoning = requestReasoningLevel(request)
	return {
		"gen_ai.operation.name": "chat",
		"gen_ai.provider.name": String(request.model.provider),
		"gen_ai.request.model": String(request.model.id),
		"gen_ai.request.stream": options.stream,
		// Only what the request actually asks for — Maple sets no generation cap
		// today, so this appears the day a call site does, not before.
		...(request.generation?.maxTokens === undefined
			? undefined
			: { "gen_ai.request.max_tokens": request.generation.maxTokens }),
		...(reasoning === undefined ? undefined : { "gen_ai.request.reasoning.level": reasoning }),
		"gen_ai.input.messages": input.json,
		...(request.system.length > 0
			? { "gen_ai.system_instructions": systemInstructionsJson(request.system) }
			: undefined),
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

/**
 * The dollar cost the provider itself reported for the call, or nothing.
 *
 * OpenRouter is the only provider that prices per call in-band: with usage
 * accounting on (see `withUsageAccounting` in `platform/Llm.ts`) the final
 * usage object carries `cost` in credits (USD), which the vendored protocol
 * passes through `providerMetadata.openai`. Maple never prices tokens itself —
 * a price table would drift from the provider's actual billing.
 */
const reportedCost = (usage: LLMResponse["usage"]): number | undefined => {
	const openai = usage?.providerMetadata?.["openai"]
	if (typeof openai !== "object" || openai === null) return undefined
	const cost = (openai as { readonly cost?: unknown }).cost
	return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined
}

/**
 * Response identity off the wire — every OpenAI-chat chunk carries the
 * response id and the model that actually served it (OpenRouter routes, so it
 * can differ from `gen_ai.request.model`); the vendored protocol surfaces both
 * on the finish event's `providerMetadata.openai`.
 */
const responseIdentity = (response: LLMResponse): { readonly id?: string; readonly model?: string } => {
	const finish = response.events.find((event) => event.type === "finish")
	const openai = finish?.type === "finish" ? finish.providerMetadata?.["openai"] : undefined
	if (typeof openai !== "object" || openai === null) return {}
	const { id, model } = openai as { readonly id?: unknown; readonly model?: unknown }
	return {
		...(typeof id === "string" && id !== "" ? { id } : undefined),
		...(typeof model === "string" && model !== "" ? { model } : undefined),
	}
}

/**
 * The response half of a model-call span, as a plain record. Exported for
 * tests; production callers go through {@link annotateModelResponse}.
 */
export const modelResponseAttributes = (response: LLMResponse): Record<string, unknown> => {
	const usage = response.usage
	const cost = reportedCost(usage)
	const served = responseIdentity(response)
	return {
		...(served.id === undefined ? undefined : { "gen_ai.response.id": served.id }),
		...(served.model === undefined ? undefined : { "gen_ai.response.model": served.model }),
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
		// The semconv spelling. The read side's primary is the older
		// `cache_creation` key and decodes both (see `GENAI_LEGACY_ALIASES`).
		...(usage?.cacheWriteInputTokens === undefined
			? undefined
			: { "gen_ai.usage.cache_write.input_tokens": usage.cacheWriteInputTokens }),
		...(usage?.reasoningTokens === undefined
			? undefined
			: { "gen_ai.usage.reasoning.output_tokens": usage.reasoningTokens }),
		...(cost === undefined ? undefined : { "gen_ai.usage.cost": cost }),
	}
}

/** The response half of a model-call span: finish reason, usage, output, cost. */
export const annotateModelResponse = (response: LLMResponse): Effect.Effect<void> =>
	// Suspended so building the attribute record — which serializes the output
	// message — happens inside the returned Effect, not at call-site evaluation.
	Effect.suspend(() => Effect.annotateCurrentSpan(modelResponseAttributes(response)))

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
 * Per-attempt clock for the two timings the span itself cannot carry.
 *
 * The span's wall clock covers the whole stream lifetime — including the SSE
 * frames and durable writes that *consume* the model's output — so it
 * systematically overstates the model. These two attributes are the honest
 * numbers: request start → first provider frame (`time_to_first_chunk`,
 * seconds, the key the session view's occupancy bar reads), and request start
 * → terminal event (model duration, milliseconds).
 */
export interface ModelCallTiming {
	readonly startedMs: number
	firstChunkMs: number | undefined
}

/**
 * Annotate the current model-call span as events arrive: TTFT on the first
 * provider frame (`step-start` is emitted while processing that frame, never
 * before the network, so the first event of any type is the first byte), the
 * model's own duration on the terminal event.
 */
export const annotateModelCallTiming = (timing: ModelCallTiming, event: LLMEvent): Effect.Effect<void> =>
	Effect.suspend(() => {
		const first = timing.firstChunkMs === undefined
		const terminal = event.type === "finish" || event.type === "provider-error"
		if (!first && !terminal) return Effect.void
		return Effect.flatMap(Clock.currentTimeMillis, (now) => {
			if (first) timing.firstChunkMs = now
			return Effect.annotateCurrentSpan({
				...(first
					? { "gen_ai.response.time_to_first_chunk": (now - timing.startedMs) / 1000 }
					: undefined),
				...(terminal ? { [MAPLE_GENAI_MODEL_DURATION_MS_ATTR]: now - timing.startedMs } : undefined),
			})
		})
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
	description?: string,
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
				...(description === undefined || description === ""
					? undefined
					: { "gen_ai.tool.description": description }),
				"gen_ai.tool.call.id": call.id,
				"gen_ai.tool.call.arguments": toolCallJson(call.input),
				...identityAttributes(identity),
			},
		}),
	)
