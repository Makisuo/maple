import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { TinybirdDateTime } from "../query-engine"
import { Authorization } from "./current-tenant"
import { warehouseHttpErrors } from "./warehouse"

// ---------------------------------------------------------------------------
// Agent Traces endpoint schemas
//
// An **agent trace** is one end-to-end agent conversation, reconstructed from raw
// `traces` rows carrying the OTel GenAI conventions. Backed entirely by the
// queries in `@maple/query-engine/ch` — there is no agent traces datasource.
//
// Two rules run through every schema here:
//
// - **Cost is nullable end to end.** It has no stable semantic convention and
//   most emitters never send it. `null` means "unknown", and the UI omits the
//   stat rather than rendering $0.00.
// - **Message content is optional.** Privacy modes strip exactly the system
//   prompt, inputs and outputs while keeping all timing, model and token data.
//   That is an expected state, so `content: null` is normal — never an error.
// ---------------------------------------------------------------------------

/**
 * How far back a detail read scans when the caller names no window.
 *
 * An `agentTraceId` alone doesn't bound the scan (`CH.compile` requires a range),
 * and a hand-built or shared URL routinely carries no time hint — so this is
 * deliberately wide. Exported so the API and the web client cannot drift into
 * summarizing one window while the timeline below it reads another.
 */
export const AGENT_TRACE_DETAIL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Hard cap on the spans one timeline read will assemble. */
export const AGENT_TRACE_TIMELINE_SPAN_CAP = 1000

/**
 * Page size / cursor guards. Without them a negative `limit` reaches the SQL
 * builder, which rounds it into `LIMIT -5` — a 500 where a 400 belongs.
 */
export const AgentTracePageLimit = Schema.Number.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 1, maximum: 200 }),
)
export const AgentTracePageOffset = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
/** Durations, turn counts, token counts and dollars are all non-negative. */
const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))

/** Where a missing message body went — absent, or in span events we don't read yet. */
export const AgentTraceContentSource = Schema.Literals(["attributes", "events", "absent"])

/** succeeded / errored / still running. */
export const AgentTraceStatus = Schema.Literals(["ok", "error", "running"])

export const AgentTraceSortKey = Schema.Literals(["startTime", "duration", "cost", "turns", "tokens"])

export const AgentTraceSortDirection = Schema.Literals(["asc", "desc"])

// --- Filters (shared by list + facets, so the two can never drift) ---

/**
 * The filter vocabulary. Every field is `Schema.optional` (not `optionalKey`):
 * the web and MCP clients build these payloads JS-side and pass explicit
 * `undefined` for unset filters, which `optionalKey` would reject at
 * construction time. See CLAUDE.md.
 */
export const agentTraceFilterFields = {
	/** Served model (`gen_ai.response.model`, falling back to the request model). */
	model: Schema.optional(Schema.String),
	/** Requested model — the divergence side of a router like OpenRouter. */
	requestedModel: Schema.optional(Schema.String),
	provider: Schema.optional(Schema.String),
	agent: Schema.optional(Schema.String),
	workflow: Schema.optional(Schema.String),
	serviceName: Schema.optional(Schema.String),
	status: Schema.optional(AgentTraceStatus),
	/** `length` here is the silent failure: a response truncated by a token cap. */
	finishReason: Schema.optional(Schema.String),
	hasTools: Schema.optional(Schema.Boolean),
	/** Only agent traces whose message content was stripped. */
	contentRedacted: Schema.optional(Schema.Boolean),
	/** Case-insensitive substring over the title sample and the agent trace id. */
	search: Schema.optional(Schema.String),
	durationMinMs: Schema.optional(NonNegative),
	durationMaxMs: Schema.optional(NonNegative),
	turnMin: Schema.optional(NonNegative),
	turnMax: Schema.optional(NonNegative),
	tokenMin: Schema.optional(NonNegative),
	tokenMax: Schema.optional(NonNegative),
	/** Dollars. Bounds exclude agent traces with no cost data at all — an unknown
	 *  cost cannot be said to fall within a bound. */
	costMin: Schema.optional(NonNegative),
	costMax: Schema.optional(NonNegative),
} as const

// --- List ---

export class ListAgentTracesRequest extends Schema.Class<ListAgentTracesRequest>("ListAgentTracesRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	...agentTraceFilterFields,
	sort: Schema.optional(AgentTraceSortKey),
	sortDirection: Schema.optional(AgentTraceSortDirection),
	limit: Schema.optional(AgentTracePageLimit),
	offset: Schema.optional(AgentTracePageOffset),
}) {}

export const AgentTraceListItem = Schema.Struct({
	/** Derived: `gen_ai.conversation.id` → `session.id` → `TraceId`, resolved
	 *  per trace. Opaque to the client; it is the detail route's path param. */
	agentTraceId: Schema.String,
	/** First user message, when there is one. `null` for a redacted agent trace —
	 *  the row then falls back to agent → model → id, and must never look empty. */
	title: Schema.NullOr(Schema.String),
	startTime: Schema.String,
	endTime: Schema.String,
	durationMs: Schema.Number,
	turnCount: Schema.Number,
	toolCallCount: Schema.Number,
	toolErrorCount: Schema.Number,
	errorCount: Schema.Number,
	spanCount: Schema.Number,
	traceCount: Schema.Number,
	inputTokens: Schema.Number,
	outputTokens: Schema.Number,
	totalTokens: Schema.Number,
	cachedInputTokens: Schema.Number,
	reasoningTokens: Schema.Number,
	/** `null` when no span carried a cost attribute — not 0. */
	cost: Schema.NullOr(Schema.Number),
	/** Served models, in use order-agnostic set form. An agent trace can hop models
	 *  mid-conversation, so this is routinely longer than one. */
	models: Schema.Array(Schema.String),
	requestedModels: Schema.Array(Schema.String),
	providers: Schema.Array(Schema.String),
	agents: Schema.Array(Schema.String),
	workflowName: Schema.String,
	finishReasons: Schema.Array(Schema.String),
	serviceName: Schema.String,
	status: AgentTraceStatus,
	/** True when no span carried message content in attributes. */
	contentRedacted: Schema.Boolean,
	/** True when content exists but only as span events (older SDKs). */
	contentInEvents: Schema.Boolean,
})

export class ListAgentTracesResponse extends Schema.Class<ListAgentTracesResponse>("ListAgentTracesResponse")({
	data: Schema.Array(AgentTraceListItem),
}) {}

// --- Facets (filter sidebar option counts) ---

export class AgentTraceFacetsRequest extends Schema.Class<AgentTraceFacetsRequest>("AgentTraceFacetsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	...agentTraceFilterFields,
}) {}

export const AgentTraceFacetItem = Schema.Struct({
	name: Schema.String,
	count: Schema.Number,
})

export class AgentTraceFacetsResponse extends Schema.Class<AgentTraceFacetsResponse>("AgentTraceFacetsResponse")({
	models: Schema.Array(AgentTraceFacetItem),
	providers: Schema.Array(AgentTraceFacetItem),
	agents: Schema.Array(AgentTraceFacetItem),
	workflows: Schema.Array(AgentTraceFacetItem),
	services: Schema.Array(AgentTraceFacetItem),
	finishReasons: Schema.Array(AgentTraceFacetItem),
	/** Agent traces per status bucket (`ok` / `error` / `running`). */
	statuses: Schema.Array(AgentTraceFacetItem),
	/** Agent traces that executed at least one tool. */
	toolCount: Schema.Number,
	/** Agent traces with no message content at all. */
	redactedCount: Schema.Number,
	/** Duration distribution: `name` is the bucket floor in ms, and each ceiling
	 *  is floor × √2 (half-octave buckets from 1s). Unordered — client sorts. */
	durationBuckets: Schema.Array(AgentTraceFacetItem),
	durationP50: Schema.Number,
	durationP95: Schema.Number,
	turnP50: Schema.Number,
	turnP95: Schema.Number,
	tokenP50: Schema.Number,
	tokenP95: Schema.Number,
	/** Dollars (the wire carries micro-dollars; the API divides). `0` when no
	 *  agent trace in the window carried cost data. */
	costP50: Schema.Number,
	costP95: Schema.Number,
}) {}

// --- Summary (detail header) ---

export class AgentTraceSummaryRequest extends Schema.Class<AgentTraceSummaryRequest>("AgentTraceSummaryRequest")({
	agentTraceId: Schema.String,
	// `CH.compile` needs a window and an agent trace id alone doesn't bound the scan,
	// so the route defaults it wide (7 days) when the caller omits it.
	startTime: Schema.optional(TinybirdDateTime),
	endTime: Schema.optional(TinybirdDateTime),
}) {}

export class AgentTraceSummaryResponse extends Schema.Class<AgentTraceSummaryResponse>("AgentTraceSummaryResponse")({
	data: Schema.NullOr(AgentTraceListItem),
}) {}

// --- Timeline (detail body) ---

export class AgentTraceTimelineRequest extends Schema.Class<AgentTraceTimelineRequest>("AgentTraceTimelineRequest")({
	agentTraceId: Schema.String,
	startTime: Schema.optional(TinybirdDateTime),
	endTime: Schema.optional(TinybirdDateTime),
	limit: Schema.optional(AgentTracePageLimit),
	offset: Schema.optional(AgentTracePageOffset),
}) {}

export const AgentTraceEventKind = Schema.Literals([
	"systemPrompt",
	"message",
	"toolCall",
	"operation",
	"agentHandoff",
])

export const AgentTraceMessageRole = Schema.Literals(["user", "assistant", "system", "tool", "unknown"])

export const AgentTraceEventStatus = Schema.Literals(["ok", "error", "unset"])

/**
 * One timeline row. Deliberately ONE struct discriminated by `kind` rather than
 * a union of five: the standard keeps adding operations (`retrieval`, `plan`,
 * memory, `invoke_agent`), and a client that switches on `kind` with a default
 * branch keeps rendering an agent trace that contains an operation it has never
 * heard of. Fields that don't apply to a kind are `null`.
 *
 * Cumulative `gen_ai.input.messages` are already deduped server-side, and tool
 * calls already carry `parentEventId` pointing at the assistant message that
 * requested them — clients render this list, they do not re-derive it.
 */
export const AgentTraceEvent = Schema.Struct({
	id: Schema.String,
	kind: AgentTraceEventKind,
	timestamp: Schema.String,
	spanId: Schema.String,
	parentSpanId: Schema.String,
	traceId: Schema.String,
	operation: Schema.String,
	spanName: Schema.String,
	role: Schema.NullOr(AgentTraceMessageRole),
	/** `null` whenever the text is unavailable — check `contentSource` for why. */
	content: Schema.NullOr(Schema.String),
	contentSource: AgentTraceContentSource,
	/** Set on the ONE event that owns its span's work, so summing a column over
	 *  the timeline can't double count. */
	durationMs: Schema.NullOr(Schema.Number),
	model: Schema.NullOr(Schema.String),
	requestedModel: Schema.NullOr(Schema.String),
	provider: Schema.NullOr(Schema.String),
	inputTokens: Schema.NullOr(Schema.Number),
	outputTokens: Schema.NullOr(Schema.Number),
	cachedInputTokens: Schema.NullOr(Schema.Number),
	reasoningTokens: Schema.NullOr(Schema.Number),
	cost: Schema.NullOr(Schema.Number),
	finishReason: Schema.NullOr(Schema.String),
	agentName: Schema.NullOr(Schema.String),
	workflowName: Schema.NullOr(Schema.String),
	toolName: Schema.NullOr(Schema.String),
	toolCallId: Schema.NullOr(Schema.String),
	toolArguments: Schema.NullOr(Schema.String),
	toolResult: Schema.NullOr(Schema.String),
	/** The assistant message this tool call nests under, when resolvable. */
	parentEventId: Schema.NullOr(Schema.String),
	status: AgentTraceEventStatus,
	statusMessage: Schema.NullOr(Schema.String),
})

export class AgentTraceTimelineResponse extends Schema.Class<AgentTraceTimelineResponse>("AgentTraceTimelineResponse")(
	{
		events: Schema.Array(AgentTraceEvent),
		/** Spans read before assembly. Equal to the row cap ⇒ the agent trace was cut off. */
		spanCount: Schema.Number,
		/** True when the row cap was hit and the timeline is incomplete. */
		truncated: Schema.Boolean,
	},
) {}

// ---------------------------------------------------------------------------
// API group
// ---------------------------------------------------------------------------

// Exactly the warehouse family. Every handler in this group does one thing —
// `warehouse.compiledQuery` — so the QueryEngine execution/timeout errors the
// other read groups declare are unreachable here, and declaring an error a
// handler cannot produce is a client contract that will never be exercised.
const agentTraceEndpointErrors = warehouseHttpErrors

export class GenAiAgentTracesApiGroup extends HttpApiGroup.make("genaiAgentTraces")
	.add(
		HttpApiEndpoint.post("listAgentTraces", "/list", {
			payload: ListAgentTracesRequest,
			success: ListAgentTracesResponse,
			error: agentTraceEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("facets", "/facets", {
			payload: AgentTraceFacetsRequest,
			success: AgentTraceFacetsResponse,
			error: agentTraceEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("agentTraceSummary", "/summary", {
			payload: AgentTraceSummaryRequest,
			success: AgentTraceSummaryResponse,
			error: agentTraceEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("agentTraceTimeline", "/timeline", {
			payload: AgentTraceTimelineRequest,
			success: AgentTraceTimelineResponse,
			error: agentTraceEndpointErrors,
		}),
	)
	.prefix("/api/genai-agent-traces")
	.middleware(Authorization) {}
