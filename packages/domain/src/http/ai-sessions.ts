import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { TinybirdDateTime } from "../query-engine"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"
import { warehouseReadHttpErrors } from "./warehouse"

// AI agent session endpoint schemas
//
// Backed by the `maple_ai.*` span attributes the ingest gateway stamps at
// decode time; a session is resolved at trace granularity by
// `aiSessionListQuery` in the query-engine integrations layer. The Agent
// Sessions page is behind the `agent_tracing` org rollout flag and these
// shapes exist for it alone, so they live in the internal tier where they can
// follow the UI.

export class ListAiSessionsRequest extends Schema.Class<ListAiSessionsRequest>("ListAiSessionsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	// `Schema.optional`, not `optionalKey` — matches the `ListReplaysRequest`
	// optional-payload contract for JS-constructed clients (see the note in
	// session-replay.ts and CLAUDE.md, optional vs optionalKey).
	limit: Schema.optional(Schema.Number),
	// Both filters land on the session-detection subquery, so `serviceNames`
	// means "the session-bearing spans came from this service", not "the trace
	// touched it" — see `aiSessionListQuery`.
	vendorIds: Schema.optional(Schema.Array(Schema.String)),
	serviceNames: Schema.optional(Schema.Array(Schema.String)),
}) {}

export const AiSessionListItem = Schema.Struct({
	sessionId: Schema.String,
	/** Vendor of the earliest session-bearing span, e.g. `eve`, `vercel_ai_sdk`. */
	vendorId: Schema.String,
	vendorVersion: Schema.String,
	traceCount: Schema.Number,
	/** All spans of all the session's traces, including non-AI infrastructure spans. */
	spanCount: Schema.Number,
	errorSpanCount: Schema.Number,
	/** Every service touched by the session's traces. */
	serviceNames: Schema.Array(Schema.String),
	/** Warehouse datetime literals, e.g. `2026-08-19 10:33:25.825000000`. */
	startTime: Schema.String,
	endTime: Schema.String,
	durationMs: Schema.Number,
})

export class ListAiSessionsResponse extends Schema.Class<ListAiSessionsResponse>("ListAiSessionsResponse")({
	data: Schema.Array(AiSessionListItem),
}) {}

export class ListAiSessionsFacetsRequest extends Schema.Class<ListAiSessionsFacetsRequest>(
	"ListAiSessionsFacetsRequest",
)({
	// The window and nothing else: the facets are deliberately unfiltered, so
	// picking a vendor doesn't erase the other vendors from the sidebar.
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
}) {}

export const AiSessionFacetItem = Schema.Struct({
	name: Schema.String,
	count: Schema.Number,
})

export class ListAiSessionsFacetsResponse extends Schema.Class<ListAiSessionsFacetsResponse>(
	"ListAiSessionsFacetsResponse",
)({
	/** Distinct sessions per vendor id, matching what `vendorIds` selects. */
	vendors: Schema.Array(AiSessionFacetItem),
	/** Distinct sessions per service name, matching what `serviceNames` selects. */
	services: Schema.Array(AiSessionFacetItem),
}) {}

export class GetAiSessionSpansRequest extends Schema.Class<GetAiSessionSpansRequest>(
	"GetAiSessionSpansRequest",
)({
	/** The framework's own session id, verbatim — `maple_ai.session.id`. */
	sessionId: Schema.String.check(Schema.isMinLength(1)),
	// Required, unlike the list endpoints' optional window: `aiSessionSpansQuery`
	// bounds both the session detection and the span fan-out with it, so a
	// session straddling the window edge returns only the spans inside it. The
	// caller states the window it wants, and there is no server-side default
	// that would quietly cut a session in half.
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
}) {}

/**
 * Every `gen_ai.*` value the integration layer decoded off the span, one
 * optional key per semantic-convention attribute.
 *
 * Mirrored here rather than imported from `@maple/query-engine-integrations`,
 * where the catalog that generates it lives: that package depends on
 * `@maple/query-engine`, which depends on this one, so importing it back would
 * close a workspace cycle. The two shapes are held together by a compile-time
 * assertion in the handler (`apps/api/src/routes/internal/ai-sessions.http.ts`)
 * — add a field to the catalog without adding it here and the build fails,
 * rather than the value disappearing on the wire.
 */
export const AiSessionGenAiValues = Schema.Struct({
	// operation
	operationName: Schema.optionalKey(Schema.String),
	providerName: Schema.optionalKey(Schema.String),

	// request
	requestModel: Schema.optionalKey(Schema.String),
	requestMaxTokens: Schema.optionalKey(Schema.Finite),
	requestChoiceCount: Schema.optionalKey(Schema.Finite),
	requestTemperature: Schema.optionalKey(Schema.Finite),
	requestTopP: Schema.optionalKey(Schema.Finite),
	requestTopK: Schema.optionalKey(Schema.Finite),
	requestStopSequences: Schema.optionalKey(Schema.Array(Schema.String)),
	requestFrequencyPenalty: Schema.optionalKey(Schema.Finite),
	requestPresencePenalty: Schema.optionalKey(Schema.Finite),
	requestEncodingFormats: Schema.optionalKey(Schema.Array(Schema.String)),
	requestSeed: Schema.optionalKey(Schema.Finite),
	requestStream: Schema.optionalKey(Schema.Boolean),
	requestReasoningLevel: Schema.optionalKey(Schema.String),
	requestPreviousResponseId: Schema.optionalKey(Schema.String),
	requestStreamCursor: Schema.optionalKey(Schema.String),

	// response
	responseId: Schema.optionalKey(Schema.String),
	responseModel: Schema.optionalKey(Schema.String),
	responseFinishReasons: Schema.optionalKey(Schema.Array(Schema.String)),
	responseStatus: Schema.optionalKey(Schema.String),
	responseTimeToFirstChunk: Schema.optionalKey(Schema.Finite),
	outputType: Schema.optionalKey(Schema.String),

	// usage
	usageInputTokens: Schema.optionalKey(Schema.Finite),
	usageCacheReadInputTokens: Schema.optionalKey(Schema.Finite),
	usageCacheCreationInputTokens: Schema.optionalKey(Schema.Finite),
	usageOutputTokens: Schema.optionalKey(Schema.Finite),
	usageReasoningOutputTokens: Schema.optionalKey(Schema.Finite),

	// conversation
	conversationId: Schema.optionalKey(Schema.String),
	conversationCompacted: Schema.optionalKey(Schema.Boolean),

	// agent
	agentId: Schema.optionalKey(Schema.String),
	agentName: Schema.optionalKey(Schema.String),
	agentDescription: Schema.optionalKey(Schema.String),
	agentVersion: Schema.optionalKey(Schema.String),

	// tool
	toolName: Schema.optionalKey(Schema.String),
	toolCallId: Schema.optionalKey(Schema.String),
	toolDescription: Schema.optionalKey(Schema.String),
	toolType: Schema.optionalKey(Schema.String),
	toolCallArguments: Schema.optionalKey(Schema.Unknown),
	toolCallResult: Schema.optionalKey(Schema.Unknown),
	toolDefinitions: Schema.optionalKey(Schema.Unknown),

	// content
	systemInstructions: Schema.optionalKey(Schema.Unknown),
	inputMessages: Schema.optionalKey(Schema.Unknown),
	outputMessages: Schema.optionalKey(Schema.Unknown),

	// data source / retrieval
	dataSourceId: Schema.optionalKey(Schema.String),
	retrievalQueryText: Schema.optionalKey(Schema.String),
	retrievalTopK: Schema.optionalKey(Schema.Finite),
	retrievalDocuments: Schema.optionalKey(Schema.Unknown),

	// memory
	memoryStoreId: Schema.optionalKey(Schema.String),
	memoryRecordId: Schema.optionalKey(Schema.String),
	memoryRecordCount: Schema.optionalKey(Schema.Finite),
	memoryQueryText: Schema.optionalKey(Schema.String),
	memoryRecords: Schema.optionalKey(Schema.Unknown),

	// embeddings
	embeddingsDimensionCount: Schema.optionalKey(Schema.Finite),

	// evaluation
	evaluationName: Schema.optionalKey(Schema.String),
	evaluationScoreValue: Schema.optionalKey(Schema.Finite),
	evaluationScoreLabel: Schema.optionalKey(Schema.String),
	evaluationExplanation: Schema.optionalKey(Schema.String),

	// prompt
	promptName: Schema.optionalKey(Schema.String),
	promptVersion: Schema.optionalKey(Schema.String),

	// workflow
	workflowName: Schema.optionalKey(Schema.String),

	// core semconv attributes AI spans carry
	errorType: Schema.optionalKey(Schema.String),
	serverAddress: Schema.optionalKey(Schema.String),
	serverPort: Schema.optionalKey(Schema.Finite),
})
export type AiSessionGenAiValues = Schema.Schema.Type<typeof AiSessionGenAiValues>

/**
 * One span of a session, already normalized onto Maple's standard AI span
 * shape. The raw attribute maps the query reads are the bulk of that read and
 * are dropped server-side, so what lands here is the decoded view alone.
 */
export const AiSessionSpan = Schema.Struct({
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
	/** Which integration decoded `genAi` — the default gen_ai one, or a vendor dialect. */
	integrationId: Schema.String,
	/**
	 * False for the ordinary infrastructure spans that share an agent trace.
	 * They are returned rather than dropped: the session view shows the whole
	 * agent context, not only the spans carrying AI signal.
	 */
	isAiSpan: Schema.Boolean,
	genAi: AiSessionGenAiValues,
	promptVariables: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
export type AiSessionSpan = Schema.Schema.Type<typeof AiSessionSpan>

export class GetAiSessionSpansResponse extends Schema.Class<GetAiSessionSpansResponse>(
	"GetAiSessionSpansResponse",
)({
	data: Schema.Array(AiSessionSpan),
	/**
	 * The session has more spans than one response carries. Truncation drops the
	 * END of the session, so a client must say so rather than present the result
	 * as a complete transcript.
	 */
	truncated: Schema.Boolean,
}) {}

/**
 * Encoded-response ceiling for one session's spans.
 *
 * Bounds the warehouse read, which still carries the raw attribute maps — in
 * production a single agent span runs to ~17KB of them — so this is a memory
 * ceiling for the Worker, not a statement about the (much smaller) mapped
 * response. Above the 8MB one replay events request gets, because a session is
 * read whole: there is no range parameter to narrow, so a cap that refused
 * ordinary sessions would leave the caller nothing to do.
 */
export const MAX_AI_SESSION_SPANS_RESPONSE_BYTES = 20_000_000

/**
 * The session's spans exceed `MAX_AI_SESSION_SPANS_RESPONSE_BYTES`.
 *
 * Distinct from the row cap, which truncates and reports `truncated: true`: the
 * byte ceiling aborts the read before a response can be materialized, so there
 * is nothing to return. Nothing the caller sends changes the outcome — the
 * endpoint takes no size parameter — hence `recovery: "none"`.
 */
export class AiSessionTooLargeError extends HttpTaggedError<AiSessionTooLargeError>()(
	"@maple/http/ai-sessions/AiSessionTooLargeError",
	{
		sessionId: Schema.String,
		message: Schema.String,
	},
	{
		status: 413,
		code: "ai_session_too_large",
		title: "Session is too large to load",
		message: "This session's spans are too large to return in one response.",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

// Exactly what a compiled warehouse read can fail with — not the wider
// `sessionReplayEndpointErrors` union, whose extra members (the legacy
// QueryEngine wrappers, token-mint errors) this endpoint can never produce.
const aiSessionEndpointErrors = warehouseReadHttpErrors

export class AiSessionsInternalApiGroup extends HttpApiGroup.make("aiSessionsInternal")
	.add(
		HttpApiEndpoint.post("list", "/list", {
			payload: ListAiSessionsRequest,
			success: ListAiSessionsResponse,
			error: aiSessionEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("facets", "/facets", {
			payload: ListAiSessionsFacetsRequest,
			success: ListAiSessionsFacetsResponse,
			error: aiSessionEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("spans", "/spans", {
			payload: GetAiSessionSpansRequest,
			success: GetAiSessionSpansResponse,
			error: [...aiSessionEndpointErrors, AiSessionTooLargeError],
		}),
	)
	.prefix("/internal/ai-sessions")
	.middleware(SessionAuthorization) {}
