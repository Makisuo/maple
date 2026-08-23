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

// Maple's native convention — the one dialect an app opts into deliberately
// rather than inheriting from a framework. Distinct from the gateway-owned
// `maple_ai.*` namespace above: these are ordinary span attributes an emitter
// writes itself (the gateway strips `maple_ai.*` but honours `maple.*`), and
// Maple's own agents (`apps/api` chat + investigations) are the first emitter.

/** Groups every span of one conversation/investigation into one agent session. */
export const MAPLE_NATIVE_SESSION_ID_ATTR = "maple.session.id"
/** Groups one turn's spans inside a session; lifted into `conversationId` read-side. */
export const MAPLE_NATIVE_TURN_ID_ATTR = "maple.turn.id"

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
