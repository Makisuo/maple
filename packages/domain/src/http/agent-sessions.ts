import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { TraceId } from "../primitives"
import { TinybirdDateTime } from "../query-engine"
import { SessionAuthorization } from "./current-tenant"
import { QueryEngineExecutionError, QueryEngineTimeoutError } from "./query-engine"
import { warehouseHttpErrors } from "./warehouse"

// Agent Sessions endpoint schemas
//
// The dashboard read path over the AI classification columns on `traces`
// (AiVendor / AiSessionKeyState / AiSessionKeyHash). Internal tier on purpose:
// the feature is a product scratchpad and these shapes follow the UI. The
// durable read interface is `@maple/query-engine/observability` — the handlers
// here are thin adapters over it, and the future MCP tools call the same
// functions rather than these routes.

// One filter payload for both tabs and the facets, so the sidebar counts can't
// mean something different from the rows. `vendors`/`serviceNames` are
// containment filters ("has at least one matching AI span") — classification
// is per-span and multi-vendor sessions/traces are the norm. All optional
// filters are JS-constructed by the web client → `Schema.optional`, not
// `optionalKey` (see CLAUDE.md).
const agentSessionsFilterFields = {
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	/** Vendor slugs (`AI_VENDORS` in `@maple/domain`, including `unknown:*`). */
	vendors: Schema.optional(Schema.Array(Schema.String)),
	serviceNames: Schema.optional(Schema.Array(Schema.String)),
	hasErrors: Schema.optional(Schema.Boolean),
} as const

export class AgentSessionsListRequest extends Schema.Class<AgentSessionsListRequest>(
	"AgentSessionsListRequest",
)({
	...agentSessionsFilterFields,
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
}) {}

export const AgentSessionListItem = Schema.Struct({
	/** Opaque session id: `toString(cityHash64(key))`. The plaintext key lives in
	 *  span attributes under a vendor-specific key and is resolved by the detail
	 *  read, not the list. */
	sessionKeyHash: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	durationMs: Schema.Number,
	traceCount: Schema.Number,
	/** Only the session-authoritative key-carrying spans — a session's traces
	 *  hold more spans than this. Same population for `errorCount`. */
	keyedSpanCount: Schema.Number,
	errorCount: Schema.Number,
	vendors: Schema.Array(Schema.String),
	serviceNames: Schema.Array(Schema.String),
})

export class AgentSessionsListResponse extends Schema.Class<AgentSessionsListResponse>(
	"AgentSessionsListResponse",
)({
	data: Schema.Array(AgentSessionListItem),
}) {}

export class AgentTracesListRequest extends Schema.Class<AgentTracesListRequest>(
	"AgentTracesListRequest",
)({
	...agentSessionsFilterFields,
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
}) {}

export const AgentTraceListItem = Schema.Struct({
	traceId: TraceId,
	startTime: Schema.String,
	endTime: Schema.String,
	/** Window of the trace's AI spans only — the full trace can be wider. */
	durationMs: Schema.Number,
	aiSpanCount: Schema.Number,
	errorCount: Schema.Number,
	vendors: Schema.Array(Schema.String),
	serviceNames: Schema.Array(Schema.String),
	firstSpanName: Schema.String,
	/** max(AiSessionKeyState): 6 = belongs to a session, lower explains why not
	 *  (write-side enum in `ai_classifier.rs`). */
	bestSessionKeyState: Schema.Number,
	/** Session key hash as a string, `''` when the trace carries none. */
	sessionKeyHash: Schema.String,
})

export class AgentTracesListResponse extends Schema.Class<AgentTracesListResponse>(
	"AgentTracesListResponse",
)({
	data: Schema.Array(AgentTraceListItem),
}) {}

export class AgentSessionsFacetsRequest extends Schema.Class<AgentSessionsFacetsRequest>(
	"AgentSessionsFacetsRequest",
)({
	...agentSessionsFilterFields,
	/** Counting unit for every facet — match the open tab. */
	tab: Schema.Literals(["sessions", "traces"]),
}) {}

export const AgentFacetItem = Schema.Struct({
	name: Schema.String,
	count: Schema.Number,
})

export class AgentSessionsFacetsResponse extends Schema.Class<AgentSessionsFacetsResponse>(
	"AgentSessionsFacetsResponse",
)({
	vendors: Schema.Array(AgentFacetItem),
	services: Schema.Array(AgentFacetItem),
	/** Sessions/traces (per `tab`) with at least one errored AI span, within the
	 *  current filter. */
	errorCount: Schema.Number,
}) {}

export class AgentSessionDetailRequest extends Schema.Class<AgentSessionDetailRequest>(
	"AgentSessionDetailRequest",
)({
	/** Opaque session id from the list rows: `toString(AiSessionKeyHash)`. */
	sessionKeyHash: Schema.String,
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
}) {}

/** One AI span with the vendor-integration facts merged in. The raw attribute
 *  maps stay out of this shape — conversational content travels only as the
 *  integration layer's extracted (and truncated) `inputText`/`outputText`. */
export const NormalizedAiSpanItem = Schema.Struct({
	spanId: Schema.String,
	parentSpanId: Schema.String,
	startTime: Schema.String,
	durationMs: Schema.Number,
	spanName: Schema.String,
	spanKind: Schema.String,
	serviceName: Schema.String,
	statusCode: Schema.String,
	statusMessage: Schema.String,
	vendor: Schema.String,
	sessionKeyState: Schema.Number,
	role: Schema.Literals(["llm", "tool", "agent", "workflow", "other"]),
	model: Schema.NullOr(Schema.String),
	inputTokens: Schema.NullOr(Schema.Number),
	outputTokens: Schema.NullOr(Schema.Number),
	cacheReadTokens: Schema.NullOr(Schema.Number),
	cacheCreationTokens: Schema.NullOr(Schema.Number),
	costUsd: Schema.NullOr(Schema.Number),
	sessionKey: Schema.NullOr(Schema.String),
	/** Vendor-recorded conversational content (messages JSON / prompt / tool
	 *  args and result), truncated server-side. Raw strings — format varies per
	 *  vendor and rendering is the client's job. */
	inputText: Schema.NullOr(Schema.String),
	outputText: Schema.NullOr(Schema.String),
})

export const AgentSessionTraceItem = Schema.Struct({
	traceId: TraceId,
	startTime: Schema.String,
	durationMs: Schema.Number,
	errorCount: Schema.Number,
	spans: Schema.Array(NormalizedAiSpanItem),
})

export const AgentSessionDetail = Schema.Struct({
	sessionKeyHash: Schema.String,
	/** Plaintext session key when a vendor integration resolved one; the UI
	 *  falls back to the hash. */
	sessionKey: Schema.NullOr(Schema.String),
	startTime: Schema.String,
	endTime: Schema.String,
	durationMs: Schema.Number,
	/** The session blew a fetch cap and every count below undercounts. */
	truncated: Schema.Boolean,
	totals: Schema.Struct({
		spanCount: Schema.Number,
		llmCallCount: Schema.Number,
		toolCallCount: Schema.Number,
		errorCount: Schema.Number,
		inputTokens: Schema.Number,
		outputTokens: Schema.Number,
		cacheReadTokens: Schema.Number,
		cacheCreationTokens: Schema.Number,
		/** `null` when no span priced itself — unknown, never free. */
		costUsd: Schema.NullOr(Schema.Number),
	}),
	vendors: Schema.Array(Schema.String),
	serviceNames: Schema.Array(Schema.String),
	models: Schema.Array(Schema.String),
	traces: Schema.Array(AgentSessionTraceItem),
})

export class AgentSessionDetailResponse extends Schema.Class<AgentSessionDetailResponse>(
	"AgentSessionDetailResponse",
)({
	/** `null`: the hash matched nothing in the window (expired, or a foreign id). */
	session: Schema.NullOr(AgentSessionDetail),
}) {}

const agentSessionsEndpointErrors = [
	QueryEngineExecutionError,
	QueryEngineTimeoutError,
	...warehouseHttpErrors,
] as const

export class AgentSessionsInternalApiGroup extends HttpApiGroup.make("agentSessionsInternal")
	.add(
		HttpApiEndpoint.post("list", "/list", {
			payload: AgentSessionsListRequest,
			success: AgentSessionsListResponse,
			error: agentSessionsEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("traces", "/traces", {
			payload: AgentTracesListRequest,
			success: AgentTracesListResponse,
			error: agentSessionsEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("detail", "/detail", {
			payload: AgentSessionDetailRequest,
			success: AgentSessionDetailResponse,
			error: agentSessionsEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("facets", "/facets", {
			payload: AgentSessionsFacetsRequest,
			success: AgentSessionsFacetsResponse,
			error: agentSessionsEndpointErrors,
		}),
	)
	.prefix("/internal/agent-sessions")
	.middleware(SessionAuthorization) {}
