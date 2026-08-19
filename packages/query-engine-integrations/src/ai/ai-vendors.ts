// Per-vendor overrides, keyed by the `maple_ai.vendor.id` the ingest gateway
// stamped on the span.
//
// Only three entries exist, and that is the point: the default GenAI
// integration already maps the twenty-two detected vendors that emit canonical
// `gen_ai.*` attributes, so an override is only worth writing for a framework
// with a genuinely different dialect. Adding one later is a single entry in the
// table at the bottom of this file — no registration step, no new mechanism.
//
// Every key below was verified against the emitting source (the installed AI
// SDK's own telemetry keys, the OpenInference semantic-convention spec, and
// real spans in this org's warehouse). Keys that could not be verified were
// dropped rather than guessed: a wrong key is invisible — it simply never
// matches — which makes guesses uniquely expensive to discover later.

import type { AiIntegration, AiRefineContext } from "./ai-integrations"
import type { MutableAiGenAiValues } from "./ai-span-model"

/**
 * Vercel AI SDK — the `ai.*` dialect.
 *
 * Current AI SDK versions emit proper `gen_ai.*` attributes (production spans
 * from `apps/slack-agent`, which runs the SDK through eve, carry
 * `gen_ai.operation.name`, `gen_ai.usage.*` and friends), so every canonical
 * key is listed FIRST and the `ai.*` keys are strictly lower-priority aliases
 * for older versions. All `ai.*` keys here appear verbatim in the installed
 * `ai` package's telemetry code.
 *
 * Deliberately not mapped: `ai.response.text` (plain text, not the JSON message
 * array `outputMessages` holds), `ai.operationId` (an SDK function id such as
 * `ai.generateText.doGenerate`, not a `gen_ai.operation.name` value), and
 * `ai.response.msToFirstChunk` (milliseconds, where
 * `gen_ai.response.time_to_first_chunk` is seconds — silently mixing units is
 * worse than not having the field).
 */
const vercelAiSdkIntegration: AiIntegration = {
	id: "vercel_ai_sdk",
	sources: {
		requestModel: ["gen_ai.request.model", "ai.model.id"],
		providerName: ["gen_ai.provider.name", "gen_ai.system", "ai.model.provider"],
		responseId: ["gen_ai.response.id", "ai.response.id"],
		responseModel: ["gen_ai.response.model", "ai.response.model"],
		responseFinishReasons: [
			"gen_ai.response.finish_reasons",
			"gen_ai.response.finish_reason",
			"ai.response.finishReason",
		],
		usageInputTokens: [
			"gen_ai.usage.input_tokens",
			"gen_ai.usage.prompt_tokens",
			"ai.usage.inputTokens",
			"ai.usage.promptTokens",
		],
		usageOutputTokens: [
			"gen_ai.usage.output_tokens",
			"gen_ai.usage.completion_tokens",
			"ai.usage.outputTokens",
			"ai.usage.completionTokens",
		],
		usageCacheReadInputTokens: [
			"gen_ai.usage.cache_read.input_tokens",
			"ai.usage.cachedInputTokens",
			"ai.usage.inputTokenDetails.cacheReadTokens",
		],
		usageCacheCreationInputTokens: [
			"gen_ai.usage.cache_creation.input_tokens",
			"ai.usage.inputTokenDetails.cacheWriteTokens",
		],
		usageReasoningOutputTokens: [
			"gen_ai.usage.reasoning.output_tokens",
			"gen_ai.usage.output_tokens.reasoning",
			"ai.usage.reasoningTokens",
			"ai.usage.outputTokenDetails.reasoningTokens",
		],
		inputMessages: ["gen_ai.input.messages", "gen_ai.prompt", "ai.prompt.messages", "ai.prompt"],
		outputMessages: ["gen_ai.output.messages", "gen_ai.completion"],
		toolName: ["gen_ai.tool.name", "ai.toolCall.name"],
		toolCallId: ["gen_ai.tool.call.id", "ai.toolCall.id"],
		toolCallArguments: ["gen_ai.tool.call.arguments", "ai.toolCall.args"],
		toolCallResult: ["gen_ai.tool.call.result", "ai.toolCall.result"],
		toolDefinitions: ["gen_ai.tool.definitions", "ai.prompt.tools"],
		// `ai.telemetry.functionId` is the name the app gave the traced call. In
		// this org's spans it carries the same value the sibling `invoke_agent`
		// span puts in `gen_ai.agent.name` (`slack-agent`), which is the only
		// agent identity an older-SDK span has.
		agentName: ["gen_ai.agent.name", "ai.telemetry.functionId"],
	},
}

/**
 * OpenInference span kinds that have a `gen_ai.operation.name` equivalent. The
 * kinds left out (`CHAIN`, `RERANKER`, `GUARDRAIL`, `EVALUATOR`, `PROMPT`,
 * `UNKNOWN`) have no counterpart in the convention, and inventing one would put
 * a value in `operationName` that no GenAI dashboard filter can match.
 */
const OPENINFERENCE_SPAN_KIND_OPERATIONS = new Map([
	["LLM", "chat"],
	["TOOL", "execute_tool"],
	["AGENT", "invoke_agent"],
	["EMBEDDING", "embeddings"],
	["RETRIEVER", "retrieval"],
])

/**
 * OpenInference — the dialect Arize's instrumentors emit. Registered under both
 * `openinference-openai` (the gateway's id for the OpenAI instrumentor) and
 * `unknown:openinference` (its generic bucket for any other OpenInference
 * scope), because the dialect is identical; only the detection path differs.
 *
 * The integration id is the DIALECT, not the vendor stamp, so both stamps
 * report the same `integrationId`.
 */
const openInferenceIntegration: AiIntegration = {
	id: "openinference",
	sources: {
		requestModel: ["gen_ai.request.model", "llm.model_name"],
		providerName: ["gen_ai.provider.name", "gen_ai.system", "llm.provider", "llm.system"],
		usageInputTokens: ["gen_ai.usage.input_tokens", "llm.token_count.prompt"],
		usageOutputTokens: ["gen_ai.usage.output_tokens", "llm.token_count.completion"],
		usageCacheReadInputTokens: [
			"gen_ai.usage.cache_read.input_tokens",
			"llm.token_count.prompt_details.cache_read",
		],
		usageReasoningOutputTokens: [
			"gen_ai.usage.reasoning.output_tokens",
			"llm.token_count.completion_details.reasoning",
		],
		inputMessages: ["gen_ai.input.messages", "llm.input_messages", "input.value"],
		outputMessages: ["gen_ai.output.messages", "llm.output_messages", "output.value"],
		toolName: ["gen_ai.tool.name", "tool.name"],
		toolDescription: ["gen_ai.tool.description", "tool.description"],
		toolCallArguments: ["gen_ai.tool.call.arguments", "tool.parameters"],
		toolDefinitions: ["gen_ai.tool.definitions", "llm.tools"],
	},
	refine: (values: MutableAiGenAiValues, ctx: AiRefineContext) => {
		// `openinference.span.kind` is the dialect's operation classifier, but it
		// is an enum of a different vocabulary rather than a differently named
		// `gen_ai.operation.name`, so translating it is a refine, not an alias.
		if (values.operationName !== undefined) return
		const operation = OPENINFERENCE_SPAN_KIND_OPERATIONS.get(
			ctx.attributes["openinference.span.kind"] ?? "",
		)
		if (operation !== undefined) values.operationName = operation
	},
}

/**
 * eve — a session envelope rather than a GenAI dialect.
 *
 * eve's own spans (`ai.eve.turn`) carry `eve.session.id`, `eve.turn.id`,
 * `eve.environment` and `eve.version`, and nothing else AI-shaped: the model
 * call itself is made through the Vercel AI SDK on child spans, which the
 * gateway stamps separately. The session id is already lifted into
 * `maple_ai.session.id`, and `eve.environment` / `eve.version` describe the
 * deployment rather than the generation, so the only mapping worth making is
 * the turn id — the conversation-level grouping key inside a session. This
 * override is deliberately minimal.
 */
const eveIntegration: AiIntegration = {
	id: "eve",
	sources: {},
	refine: (values: MutableAiGenAiValues, ctx: AiRefineContext) => {
		if (values.conversationId !== undefined) return
		const turnId = ctx.attributes["eve.turn.id"]
		if (turnId !== undefined && turnId !== "") values.conversationId = turnId
	},
}

/**
 * Vendor id → override. Every id the gateway can stamp that is NOT in here maps
 * through the default GenAI integration, which is the right answer for the
 * frameworks that emit canonical `gen_ai.*`.
 */
export interface AiVendorRegistry {
	readonly [vendorId: string]: AiIntegration | undefined
}

export const AI_VENDOR_INTEGRATIONS: AiVendorRegistry = {
	vercel_ai_sdk: vercelAiSdkIntegration,
	"openinference-openai": openInferenceIntegration,
	"unknown:openinference": openInferenceIntegration,
	eve: eveIntegration,
}
