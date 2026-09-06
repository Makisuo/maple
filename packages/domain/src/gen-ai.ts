// The standardised Maple AI-agent span — field catalog, value types, schema.
//
// Every AI framework speaks a different attribute dialect, but the dashboard
// wants one shape. This module owns that shape: a flat catalog of the GenAI
// attributes Maple reads (`AI_GENAI_FIELDS`), the value type each one decodes
// to, and the `AiAgentSpan` an integration produces. The mapping itself lives
// in `@maple/query-engine-integrations`; this file is data plus types, so the
// catalog is the single source of truth for field names, source keys and value
// types, and the wire schema is generated from it.
//
// Warehouse attributes arrive as `Map(String, String)`: `1234`, `true` and
// `["stop"]` are all strings on the wire, and a missing key reads back as `''`
// rather than as absent. The `type` tag on each field is what tells the decoder
// how to turn that string back into a value.

import { Schema } from "effect"

/** Vendor slug the ingest gateway stamped on the span. */
export const MAPLE_AI_VENDOR_ID_ATTR = "maple_ai.vendor.id"
/** Version of the vendor detection that produced the stamp, currently `"0"`. */
export const MAPLE_AI_VENDOR_VERSION_ATTR = "maple_ai.vendor.version"
/** The vendor's own session id, verbatim. */
export const MAPLE_AI_SESSION_ID_ATTR = "maple_ai.session.id"

/**
 * Prefix of the session id Maple synthesizes for a GenAI trace that carries no
 * {@link MAPLE_AI_SESSION_ID_ATTR}.
 *
 * The gateway stamps the session id only where the vendor exposes a session key
 * — haystack, litellm, llamaindex, semantic_kernel and effect_ai never do, and
 * the `unknown:*` buckets never do — so those traces have no session to belong
 * to. Each one IS its own session: `trace:<TraceId>`, with the single trace as
 * the whole context. The prefix is what keeps the two id spaces apart, and it
 * is a colon-bearing shape no framework's own key is: read the id back with
 * {@link traceSessionTraceId} rather than testing the prefix by hand.
 */
export const MAPLE_AI_TRACE_SESSION_PREFIX = "trace:"

/** A W3C trace id as the warehouse stores it — 32 lowercase hex characters. */
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/

/**
 * The trace id a synthesized session id names, or `undefined` when the id is a
 * vendor's own.
 *
 * A prefixed id that is not shaped like a trace id is `undefined` too. This
 * value reaches a warehouse `param.*`, so "looks like a trace id" is the
 * boundary check that keeps a forged one out of the trace-keyed read — it falls
 * through to the session-attribute read instead, where nothing carries it and
 * the caller gets the empty-session answer.
 */
export const traceSessionTraceId = (sessionId: string): string | undefined => {
	if (!sessionId.startsWith(MAPLE_AI_TRACE_SESSION_PREFIX)) return undefined
	const traceId = sessionId.slice(MAPLE_AI_TRACE_SESSION_PREFIX.length)
	return TRACE_ID_PATTERN.test(traceId) ? traceId : undefined
}

// Maple's native convention — the one dialect an app opts into deliberately
// rather than inheriting from a framework. These are ordinary span attributes
// an emitter writes itself, and Maple's own agents (`apps/api` chat +
// investigations) are the first emitter.
//
// The whole AI surface sits under `maple_ai.`, these included. The session id
// used to be a bare `maple.session.id` — the browser-session/replay SDK's own
// key, which the replay read routes annotate their spans with, so every replay
// read surfaced as an agent session. The rule that avoids a repeat: `maple_*`
// is Maple-internal (like `maple_org_id`), `maple.*` belongs to the SDKs.
//
// The gateway strips `maple_ai.*` on the way in and re-stamps its own verdict,
// with the exceptions it does not own and lets through: the turn id, the
// dropped-messages counter and the model-duration clock (`PRESERVED_ATTRS` in
// `apps/ingest/src/ai_session.rs`).

/**
 * Groups every span of one conversation/investigation into one agent session.
 * The one key an emitter both writes and reads back: the gateway strips it with
 * the rest of the namespace, then re-stamps it verbatim as
 * {@link MAPLE_AI_SESSION_ID_ATTR}, which is why they are the same string.
 */
export const MAPLE_NATIVE_SESSION_ID_ATTR = "maple_ai.session.id"
/** Groups one turn's spans inside a session; lifted into `conversationId` read-side. */
export const MAPLE_NATIVE_TURN_ID_ATTR = "maple_ai.turn.id"
/**
 * Count of whole oldest messages dropped from `gen_ai.input.messages` to fit
 * the emitter's attribute budget. Write-only diagnostics: nothing decodes it,
 * it is visible in raw span attributes.
 */
export const MAPLE_GENAI_INPUT_MESSAGES_DROPPED_ATTR = "maple_ai.input_messages_dropped"
/**
 * Wall-clock milliseconds from request start to the terminal stream event —
 * the model's actual latency. The span's own duration cannot carry this: the
 * span stays open while downstream consumers (SSE, durable writes) drain the
 * stream, so it systematically overstates the model. Write-only diagnostics.
 * Emitter-written like the two above, so it must appear in `PRESERVED_ATTRS`
 * or the gateway's namespace strip drops it.
 */
export const MAPLE_GENAI_MODEL_DURATION_MS_ATTR = "maple_ai.model_duration_ms"

// Usage conventions — which of a reporter's token figures already contain
// which others.
//
// The five `gen_ai.usage.*` buckets are not disjoint on every wire. OpenAI's
// `prompt_tokens` contains `prompt_tokens_details.cached_tokens` and its
// `completion_tokens` contains `completion_tokens_details.reasoning_tokens`;
// Anthropic's `input_tokens` EXCLUDES `cache_read_input_tokens` and
// `cache_creation_input_tokens`; Gemini's `candidatesTokenCount` EXCLUDES
// `thoughtsTokenCount`. A total that adds the five as if they were disjoint
// bills a cache-heavy or reasoning-heavy call nearly twice. Both readers of
// usage — `spanTokenBuckets` in the web app and `genAiTokensExpr` behind
// `ai_trace_index` — resolve the reporter's convention here first and carve
// the contained buckets back out, so `input` always means the uncached prompt,
// `output` the visible completion, and a total is always the plain sum.

export interface GenAiUsageConvention {
	/** The prompt figure already contains the cache-read and cache-write buckets. */
	readonly inputIncludesCache: boolean
	/** The completion figure already contains the reasoning bucket. */
	readonly outputIncludesReasoning: boolean
}

const NESTED: GenAiUsageConvention = { inputIncludesCache: true, outputIncludesReasoning: true }

/**
 * `gen_ai.provider.name` → the convention that provider's raw API reports
 * under. Only providers whose wire shape was checked are listed; anything else
 * takes {@link GENAI_DEFAULT_USAGE_CONVENTION}.
 */
export const GENAI_PROVIDER_USAGE_CONVENTIONS: ReadonlyMap<string, GenAiUsageConvention> = new Map([
	// Messages API: `input_tokens` excludes both cache buckets and is billed
	// beside them; `output_tokens` includes the thinking tokens.
	["anthropic", { inputIncludesCache: false, outputIncludesReasoning: true }],
	["openai", NESTED],
	// `promptTokenCount` contains `cachedContentTokenCount`, but
	// `candidatesTokenCount` excludes `thoughtsTokenCount` — the total is the
	// sum of the three.
	["gcp.gemini", { inputIncludesCache: true, outputIncludesReasoning: false }],
	["gcp.vertex_ai", { inputIncludesCache: true, outputIncludesReasoning: false }],
	// OpenAI-shaped: `total_tokens` is `prompt_tokens + completion_tokens`, with
	// the cache and reasoning counts reported as details of those two.
	["openrouter", NESTED],
])

/**
 * Vendors that re-normalise usage before emitting it, whichever provider ran
 * the call — so the vendor, not the provider, decides.
 */
export const GENAI_VENDOR_USAGE_CONVENTIONS: ReadonlyMap<string, GenAiUsageConvention> = new Map([
	// The Vercel AI SDK emits `gen_ai.usage.input_tokens` as
	// `usage.inputTokens.total` and the output as `outputTokens.total`, and its
	// providers build both totals as the sum of their parts (`@ai-sdk/anthropic`
	// sums noCache + cacheRead + cacheWrite): an Anthropic call made through the
	// SDK nests even though the raw API does not. Verified against the installed
	// packages — `ai/dist/index.mjs` for the attribute and `@ai-sdk/anthropic`
	// (vendored under `eve`) for the sum.
	["vercel_ai_sdk", NESTED],
	// `@opencode-ai/ai` normalises `inputTokens` to the inclusive total for every
	// provider (see `sumTokens` in its anthropic-messages/bedrock-converse
	// protocols) and reports reasoning as a detail of the completion count, so
	// Maple's own spans nest even when the provider's raw API does not — pinning
	// it here keeps totals right the day a direct anthropic/bedrock provider is
	// wired.
	["maple", NESTED],
])

/** What most of the field does, and the side that errs toward the smaller
 *  number rather than inventing tokens. */
export const GENAI_DEFAULT_USAGE_CONVENTION: GenAiUsageConvention = NESTED

/**
 * The convention a span's usage was reported under. The vendor is asked first
 * — a framework that re-summed the buckets before emitting them has
 * overwritten whatever its provider's own API said — then the provider, then
 * the default.
 */
export const genAiUsageConvention = (
	vendorId: string | undefined,
	providerName: string | undefined,
): GenAiUsageConvention =>
	GENAI_VENDOR_USAGE_CONVENTIONS.get(vendorId ?? "") ??
	GENAI_PROVIDER_USAGE_CONVENTIONS.get(providerName ?? "") ??
	GENAI_DEFAULT_USAGE_CONVENTION

export interface AiFieldDef {
	/** Primary source attribute key (the semconv key where one exists). */
	readonly key: string
	readonly type: "string" | "number" | "boolean" | "stringArray" | "json"
}

/**
 * The GenAI attributes Maple decodes, keyed by a camelCase field name that
 * mirrors the semconv path. `key` is the primary source key only — legacy
 * aliases are an integration concern and live in `ai-integrations.ts`, because
 * an alias is a statement about instrumentation, not about the convention.
 */
export const AI_GENAI_FIELDS = {
	// operation
	operationName: { key: "gen_ai.operation.name", type: "string" },
	providerName: { key: "gen_ai.provider.name", type: "string" },

	// request
	requestModel: { key: "gen_ai.request.model", type: "string" },
	requestMaxTokens: { key: "gen_ai.request.max_tokens", type: "number" },
	requestChoiceCount: { key: "gen_ai.request.choice.count", type: "number" },
	requestTemperature: { key: "gen_ai.request.temperature", type: "number" },
	requestTopP: { key: "gen_ai.request.top_p", type: "number" },
	requestTopK: { key: "gen_ai.request.top_k", type: "number" },
	requestStopSequences: { key: "gen_ai.request.stop_sequences", type: "stringArray" },
	requestFrequencyPenalty: { key: "gen_ai.request.frequency_penalty", type: "number" },
	requestPresencePenalty: { key: "gen_ai.request.presence_penalty", type: "number" },
	requestEncodingFormats: { key: "gen_ai.request.encoding_formats", type: "stringArray" },
	requestSeed: { key: "gen_ai.request.seed", type: "number" },
	requestStream: { key: "gen_ai.request.stream", type: "boolean" },
	requestReasoningLevel: { key: "gen_ai.request.reasoning.level", type: "string" },
	requestPreviousResponseId: { key: "gen_ai.request.previous_response.id", type: "string" },
	requestStreamCursor: { key: "gen_ai.request.stream_cursor", type: "string" },

	// response
	responseId: { key: "gen_ai.response.id", type: "string" },
	responseModel: { key: "gen_ai.response.model", type: "string" },
	responseFinishReasons: { key: "gen_ai.response.finish_reasons", type: "stringArray" },
	responseStatus: { key: "gen_ai.response.status", type: "string" },
	responseTimeToFirstChunk: { key: "gen_ai.response.time_to_first_chunk", type: "number" },
	outputType: { key: "gen_ai.output.type", type: "string" },

	// usage
	usageInputTokens: { key: "gen_ai.usage.input_tokens", type: "number" },
	usageCacheReadInputTokens: { key: "gen_ai.usage.cache_read.input_tokens", type: "number" },
	usageCacheCreationInputTokens: { key: "gen_ai.usage.cache_creation.input_tokens", type: "number" },
	usageOutputTokens: { key: "gen_ai.usage.output_tokens", type: "number" },
	usageReasoningOutputTokens: { key: "gen_ai.usage.reasoning.output_tokens", type: "number" },
	// Not in the semconv: providers do not return a price, so the convention has
	// none. Instrumentations that price calls themselves (OpenLLMetry,
	// OpenInference, Logfire) each use their own key; this is OpenLLMetry's.
	usageCost: { key: "gen_ai.usage.cost", type: "number" },

	// conversation
	conversationId: { key: "gen_ai.conversation.id", type: "string" },
	conversationCompacted: { key: "gen_ai.conversation.compacted", type: "boolean" },

	// agent
	agentId: { key: "gen_ai.agent.id", type: "string" },
	agentName: { key: "gen_ai.agent.name", type: "string" },
	agentDescription: { key: "gen_ai.agent.description", type: "string" },
	agentVersion: { key: "gen_ai.agent.version", type: "string" },

	// tool
	toolName: { key: "gen_ai.tool.name", type: "string" },
	toolCallId: { key: "gen_ai.tool.call.id", type: "string" },
	toolDescription: { key: "gen_ai.tool.description", type: "string" },
	toolType: { key: "gen_ai.tool.type", type: "string" },
	toolCallArguments: { key: "gen_ai.tool.call.arguments", type: "json" },
	toolCallResult: { key: "gen_ai.tool.call.result", type: "json" },
	toolDefinitions: { key: "gen_ai.tool.definitions", type: "json" },

	// content
	systemInstructions: { key: "gen_ai.system_instructions", type: "json" },
	inputMessages: { key: "gen_ai.input.messages", type: "json" },
	outputMessages: { key: "gen_ai.output.messages", type: "json" },

	// data source / retrieval
	dataSourceId: { key: "gen_ai.data_source.id", type: "string" },
	retrievalQueryText: { key: "gen_ai.retrieval.query.text", type: "string" },
	retrievalTopK: { key: "gen_ai.retrieval.top_k", type: "number" },
	retrievalDocuments: { key: "gen_ai.retrieval.documents", type: "json" },

	// memory
	memoryStoreId: { key: "gen_ai.memory.store.id", type: "string" },
	memoryRecordId: { key: "gen_ai.memory.record.id", type: "string" },
	memoryRecordCount: { key: "gen_ai.memory.record.count", type: "number" },
	memoryQueryText: { key: "gen_ai.memory.query.text", type: "string" },
	memoryRecords: { key: "gen_ai.memory.records", type: "json" },

	// embeddings
	embeddingsDimensionCount: { key: "gen_ai.embeddings.dimension.count", type: "number" },

	// evaluation
	evaluationName: { key: "gen_ai.evaluation.name", type: "string" },
	evaluationScoreValue: { key: "gen_ai.evaluation.score.value", type: "number" },
	evaluationScoreLabel: { key: "gen_ai.evaluation.score.label", type: "string" },
	evaluationExplanation: { key: "gen_ai.evaluation.explanation", type: "string" },

	// prompt
	promptName: { key: "gen_ai.prompt.name", type: "string" },
	promptVersion: { key: "gen_ai.prompt.version", type: "string" },

	// workflow
	workflowName: { key: "gen_ai.workflow.name", type: "string" },

	// core semconv attributes AI spans carry — see `AI_CORE_FIELDS`
	errorType: { key: "error.type", type: "string" },
	serverAddress: { key: "server.address", type: "string" },
	serverPort: { key: "server.port", type: "number" },
} as const satisfies Record<string, AiFieldDef>

export type AiGenAiField = keyof typeof AI_GENAI_FIELDS

/**
 * Plain core-semconv attributes that AI spans happen to carry, not AI signal.
 * Every ordinary HTTP client span in the trace has them too, which is why the
 * mapper refuses to treat one as evidence that a span is an AI span.
 */
export const AI_CORE_FIELDS: ReadonlySet<AiGenAiField> = new Set(["errorType", "serverAddress", "serverPort"])

/**
 * `gen_ai.prompt.variable.<name>` is a TEMPLATED attribute: the key carries the
 * variable name, so there is no single key to look up and it cannot live in
 * `AI_GENAI_FIELDS` alongside the fixed keys. The mapper collects it by prefix.
 */
export const AI_PROMPT_VARIABLE_PREFIX = "gen_ai.prompt.variable."

/** Value a field of the given `type` decodes to. */
export type AiFieldValue<T extends AiFieldDef["type"]> = T extends "string"
	? string
	: T extends "number"
		? number
		: T extends "boolean"
			? boolean
			: T extends "stringArray"
				? readonly string[]
				: unknown

/** Every catalog field, optional, typed from its `type` tag. */
export type AiGenAiValues = {
	readonly [F in AiGenAiField]?: AiFieldValue<(typeof AI_GENAI_FIELDS)[F]["type"]>
}

/** The same, writable — what an integration's `refine` hook mutates. */
export type MutableAiGenAiValues = {
	-readonly [F in AiGenAiField]?: AiFieldValue<(typeof AI_GENAI_FIELDS)[F]["type"]>
}

export interface AiAgentSpan {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly spanName: string
	readonly spanKind: string
	readonly serviceName: string
	readonly timestamp: string
	readonly durationMs: number
	readonly statusCode: string
	readonly statusMessage: string
	/** Maple AI envelope, stamped by the ingest gateway. */
	readonly sessionId?: string
	readonly vendorId?: string
	readonly vendorVersion?: string
	/**
	 * True when the span carried any recognised AI signal. False for the
	 * ordinary infrastructure spans that share an agent trace — they are
	 * returned rather than dropped, because the session view shows the whole
	 * agent context.
	 */
	readonly isAiSpan: boolean
	readonly genAi: AiGenAiValues
}

/** Schema per `type` tag, so the catalog also generates the schema. */
interface AiFieldValueSchemas {
	readonly string: Schema.String
	readonly number: Schema.Finite
	readonly boolean: Schema.Boolean
	readonly stringArray: Schema.$Array<Schema.String>
	readonly json: Schema.Unknown
}

const aiFieldValueSchemas: AiFieldValueSchemas = {
	string: Schema.String,
	number: Schema.Finite,
	boolean: Schema.Boolean,
	stringArray: Schema.Array(Schema.String),
	json: Schema.Unknown,
}

type AiGenAiFieldSchemas = {
	readonly [F in AiGenAiField]: Schema.optionalKey<AiFieldValueSchemas[(typeof AI_GENAI_FIELDS)[F]["type"]]>
}

// Generated from the catalog rather than written out, so the wire schema cannot
// drift from the field list. `Object.fromEntries` erases the key/value
// correlation, hence the cast back to the mapped type above.
const aiGenAiFieldSchemas = Object.fromEntries(
	Object.entries(AI_GENAI_FIELDS).map(([field, def]) => [
		field,
		Schema.optionalKey(aiFieldValueSchemas[def.type]),
	]),
) as AiGenAiFieldSchemas

export const AiGenAiValuesSchema = Schema.Struct(aiGenAiFieldSchemas)

export const AiAgentSpanSchema = Schema.Struct({
	traceId: Schema.String,
	spanId: Schema.String,
	parentSpanId: Schema.String,
	spanName: Schema.String,
	spanKind: Schema.String,
	serviceName: Schema.String,
	/** Warehouse datetime literal, e.g. `2026-08-19 10:33:25.825000000`. */
	timestamp: Schema.String,
	durationMs: Schema.Finite,
	statusCode: Schema.String,
	statusMessage: Schema.String,
	/** Maple AI envelope, stamped by the ingest gateway. */
	sessionId: Schema.optionalKey(Schema.String),
	vendorId: Schema.optionalKey(Schema.String),
	vendorVersion: Schema.optionalKey(Schema.String),
	/**
	 * False for the ordinary infrastructure spans that share an agent trace.
	 * They are returned rather than dropped: the session view shows the whole
	 * agent context, not only the spans carrying AI signal.
	 */
	isAiSpan: Schema.Boolean,
	genAi: AiGenAiValuesSchema,
})
