// The standardised Maple AI-agent span — field catalog, value types, schema.
//
// Every AI framework speaks a different attribute dialect, but the dashboard
// wants one shape. This module owns that shape: a flat catalog of every OTel
// GenAI semantic-convention attribute (`AI_GENAI_FIELDS`), the value type each
// one decodes to, and the `AiAgentSpan` an integration produces. The mapping
// itself lives in `ai-integrations.ts` — this file is data plus types, so the
// catalog stays the single source of truth for field names, canonical keys and
// value types, and nothing can add a field without also declaring how it
// decodes.
//
// Two facts drive the design:
//
//   1. Every `gen_ai.*` attribute is stability `development` — there are no
//      stable ones. So there is no "stable subset" to ship first; the catalog
//      carries the whole convention, in-development fields included, and the
//      cost of a field the instrumentation never emits is one absent key.
//   2. Warehouse attributes arrive as `Map(String, String)`. `1234`, `true` and
//      `["stop"]` are all strings on the wire, and a missing key reads back as
//      `''`, not as absent. The `type` tag on each field is what tells the
//      decoder how to turn that string back into a value.
//
// There is deliberately NO instrumentation-scope input here. The ingest gateway
// already did scope-based vendor detection at write time
// (`apps/ingest/src/ai_session.rs`) and encoded its verdict in
// `maple_ai.vendor.id`; re-deriving a dialect from the scope on read would be a
// second, weaker copy of that decision that could disagree with the stamp.

import { Schema } from "effect"

/** Vendor slug the ingest gateway stamped on the span. */
export const MAPLE_AI_VENDOR_ID_ATTR = "maple_ai.vendor.id"
/** Version of the vendor detection that produced the stamp, currently `"0"`. */
export const MAPLE_AI_VENDOR_VERSION_ATTR = "maple_ai.vendor.version"
/** The vendor's own session id, verbatim. */
export const MAPLE_AI_SESSION_ID_ATTR = "maple_ai.session.id"

/**
 * One span as `aiSessionSpansQuery` returns it. Declared here rather than
 * imported from the query module so the mapping layer depends on a shape, not
 * on a query — the query satisfies this structurally.
 */
export interface AiSessionSpanRow {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly spanName: string
	readonly spanKind: string
	readonly serviceName: string
	readonly durationMs: number
	readonly statusCode: string
	readonly statusMessage: string
	readonly timestamp: string
	readonly spanAttributes: Record<string, string>
	readonly resourceAttributes: Record<string, string>
}

/**
 * Semconv group a field belongs to, for grouping in the UI.
 *
 * `core` is the odd one out: `error.type`, `server.address` and `server.port`
 * are plain core-semconv attributes that AI spans happen to carry, not AI
 * signal. Every ordinary HTTP client span in the trace has them too, which is
 * why the mapper refuses to treat a `core` field as evidence that a span is an
 * AI span.
 */
export type AiFieldGroup =
	| "operation"
	| "request"
	| "response"
	| "usage"
	| "conversation"
	| "agent"
	| "tool"
	| "content"
	| "dataSource"
	| "retrieval"
	| "memory"
	| "embeddings"
	| "evaluation"
	| "prompt"
	| "workflow"
	| "core"

export interface AiFieldDef {
	/** Canonical OTel semconv attribute key. */
	readonly key: string
	readonly type: "string" | "number" | "boolean" | "stringArray" | "json"
	readonly group: AiFieldGroup
}

/**
 * Every GenAI semconv attribute, keyed by a camelCase field name that mirrors
 * the semconv path. `key` is the CANONICAL key only — legacy aliases are an
 * integration concern and live in `ai-integrations.ts`, because an alias is a
 * statement about instrumentation, not about the convention.
 */
export const AI_GENAI_FIELDS = {
	// operation
	operationName: { key: "gen_ai.operation.name", type: "string", group: "operation" },
	providerName: { key: "gen_ai.provider.name", type: "string", group: "operation" },

	// request
	requestModel: { key: "gen_ai.request.model", type: "string", group: "request" },
	requestMaxTokens: { key: "gen_ai.request.max_tokens", type: "number", group: "request" },
	requestChoiceCount: { key: "gen_ai.request.choice.count", type: "number", group: "request" },
	requestTemperature: { key: "gen_ai.request.temperature", type: "number", group: "request" },
	requestTopP: { key: "gen_ai.request.top_p", type: "number", group: "request" },
	requestTopK: { key: "gen_ai.request.top_k", type: "number", group: "request" },
	requestStopSequences: { key: "gen_ai.request.stop_sequences", type: "stringArray", group: "request" },
	requestFrequencyPenalty: { key: "gen_ai.request.frequency_penalty", type: "number", group: "request" },
	requestPresencePenalty: { key: "gen_ai.request.presence_penalty", type: "number", group: "request" },
	requestEncodingFormats: { key: "gen_ai.request.encoding_formats", type: "stringArray", group: "request" },
	requestSeed: { key: "gen_ai.request.seed", type: "number", group: "request" },
	requestStream: { key: "gen_ai.request.stream", type: "boolean", group: "request" },
	requestReasoningLevel: { key: "gen_ai.request.reasoning.level", type: "string", group: "request" },
	requestPreviousResponseId: {
		key: "gen_ai.request.previous_response.id",
		type: "string",
		group: "request",
	},
	requestStreamCursor: { key: "gen_ai.request.stream_cursor", type: "string", group: "request" },

	// response
	responseId: { key: "gen_ai.response.id", type: "string", group: "response" },
	responseModel: { key: "gen_ai.response.model", type: "string", group: "response" },
	responseFinishReasons: { key: "gen_ai.response.finish_reasons", type: "stringArray", group: "response" },
	responseStatus: { key: "gen_ai.response.status", type: "string", group: "response" },
	responseTimeToFirstChunk: {
		key: "gen_ai.response.time_to_first_chunk",
		type: "number",
		group: "response",
	},
	outputType: { key: "gen_ai.output.type", type: "string", group: "response" },

	// usage
	usageInputTokens: { key: "gen_ai.usage.input_tokens", type: "number", group: "usage" },
	usageCacheReadInputTokens: {
		key: "gen_ai.usage.cache_read.input_tokens",
		type: "number",
		group: "usage",
	},
	usageCacheCreationInputTokens: {
		key: "gen_ai.usage.cache_creation.input_tokens",
		type: "number",
		group: "usage",
	},
	usageOutputTokens: { key: "gen_ai.usage.output_tokens", type: "number", group: "usage" },
	usageReasoningOutputTokens: {
		key: "gen_ai.usage.reasoning.output_tokens",
		type: "number",
		group: "usage",
	},

	// conversation
	conversationId: { key: "gen_ai.conversation.id", type: "string", group: "conversation" },
	conversationCompacted: { key: "gen_ai.conversation.compacted", type: "boolean", group: "conversation" },

	// agent
	agentId: { key: "gen_ai.agent.id", type: "string", group: "agent" },
	agentName: { key: "gen_ai.agent.name", type: "string", group: "agent" },
	agentDescription: { key: "gen_ai.agent.description", type: "string", group: "agent" },
	agentVersion: { key: "gen_ai.agent.version", type: "string", group: "agent" },

	// tool
	toolName: { key: "gen_ai.tool.name", type: "string", group: "tool" },
	toolCallId: { key: "gen_ai.tool.call.id", type: "string", group: "tool" },
	toolDescription: { key: "gen_ai.tool.description", type: "string", group: "tool" },
	toolType: { key: "gen_ai.tool.type", type: "string", group: "tool" },
	toolCallArguments: { key: "gen_ai.tool.call.arguments", type: "json", group: "tool" },
	toolCallResult: { key: "gen_ai.tool.call.result", type: "json", group: "tool" },
	toolDefinitions: { key: "gen_ai.tool.definitions", type: "json", group: "tool" },

	// content
	systemInstructions: { key: "gen_ai.system_instructions", type: "json", group: "content" },
	inputMessages: { key: "gen_ai.input.messages", type: "json", group: "content" },
	outputMessages: { key: "gen_ai.output.messages", type: "json", group: "content" },

	// data source / retrieval
	dataSourceId: { key: "gen_ai.data_source.id", type: "string", group: "dataSource" },
	retrievalQueryText: { key: "gen_ai.retrieval.query.text", type: "string", group: "retrieval" },
	retrievalTopK: { key: "gen_ai.retrieval.top_k", type: "number", group: "retrieval" },
	retrievalDocuments: { key: "gen_ai.retrieval.documents", type: "json", group: "retrieval" },

	// memory
	memoryStoreId: { key: "gen_ai.memory.store.id", type: "string", group: "memory" },
	memoryRecordId: { key: "gen_ai.memory.record.id", type: "string", group: "memory" },
	memoryRecordCount: { key: "gen_ai.memory.record.count", type: "number", group: "memory" },
	memoryQueryText: { key: "gen_ai.memory.query.text", type: "string", group: "memory" },
	memoryRecords: { key: "gen_ai.memory.records", type: "json", group: "memory" },

	// embeddings
	embeddingsDimensionCount: {
		key: "gen_ai.embeddings.dimension.count",
		type: "number",
		group: "embeddings",
	},

	// evaluation
	evaluationName: { key: "gen_ai.evaluation.name", type: "string", group: "evaluation" },
	evaluationScoreValue: { key: "gen_ai.evaluation.score.value", type: "number", group: "evaluation" },
	evaluationScoreLabel: { key: "gen_ai.evaluation.score.label", type: "string", group: "evaluation" },
	evaluationExplanation: { key: "gen_ai.evaluation.explanation", type: "string", group: "evaluation" },

	// prompt
	promptName: { key: "gen_ai.prompt.name", type: "string", group: "prompt" },
	promptVersion: { key: "gen_ai.prompt.version", type: "string", group: "prompt" },

	// workflow
	workflowName: { key: "gen_ai.workflow.name", type: "string", group: "workflow" },

	// core semconv attributes AI spans carry — see `AiFieldGroup`
	errorType: { key: "error.type", type: "string", group: "core" },
	serverAddress: { key: "server.address", type: "string", group: "core" },
	serverPort: { key: "server.port", type: "number", group: "core" },
} as const satisfies Record<string, AiFieldDef>

export type AiGenAiField = keyof typeof AI_GENAI_FIELDS

/**
 * `gen_ai.prompt.variable.<name>` is a TEMPLATED attribute: the key carries the
 * variable name, so there is no single key to look up and it cannot live in
 * `AI_GENAI_FIELDS` alongside the fixed keys. The mapper collects it by prefix
 * into `AiAgentSpan.promptVariables` instead.
 */
export const AI_PROMPT_VARIABLE_PREFIX = "gen_ai.prompt.variable."

/**
 * The documented values of `gen_ai.operation.name`.
 *
 * NOT a closed enum, and `operationName` is deliberately a plain string: the
 * convention explicitly allows system-specific names, and production data
 * already carries `agent_step` (Vercel AI SDK). This list exists so the UI can
 * group and label the known operations — never to reject an unknown one.
 */
export const AI_KNOWN_OPERATION_NAMES = [
	"chat",
	"generate_content",
	"text_completion",
	"embeddings",
	"retrieval",
	"fetch_response",
	"create_agent",
	"invoke_agent",
	"execute_tool",
	"invoke_workflow",
	"plan",
	"search_memory",
	"create_memory",
	"update_memory",
	"upsert_memory",
	"delete_memory",
	"create_memory_store",
	"delete_memory_store",
] as const

export type AiKnownOperationName = (typeof AI_KNOWN_OPERATION_NAMES)[number]

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
	/** Which integration produced `genAi`. */
	readonly integrationId: string
	/**
	 * True when the span carried any recognised AI signal. False for the
	 * ordinary infrastructure spans that share an agent trace — they are
	 * returned rather than dropped, because the session view shows the whole
	 * agent context.
	 */
	readonly isAiSpan: boolean
	readonly genAi: AiGenAiValues
	readonly promptVariables?: Record<string, string>
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

// Generated from the catalog rather than written out: a hand-written struct of
// sixty optional fields is a second source of truth that silently drifts the
// first time someone adds a field. `Object.fromEntries` erases the key/value
// correlation, so the assertion re-states what the mapped type above already
// spells out.
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
	timestamp: Schema.String,
	durationMs: Schema.Finite,
	statusCode: Schema.String,
	statusMessage: Schema.String,
	sessionId: Schema.optionalKey(Schema.String),
	vendorId: Schema.optionalKey(Schema.String),
	vendorVersion: Schema.optionalKey(Schema.String),
	integrationId: Schema.String,
	isAiSpan: Schema.Boolean,
	genAi: AiGenAiValuesSchema,
	promptVariables: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
