import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { AiAgentSpanSchema, AiGenAiValuesSchema } from "../gen-ai"
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
	limit: Schema.optional(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
	),
	/**
	 * Rows to skip, for the list's infinite scroll. Offset-based like the
	 * replays list: the page re-runs the aggregation and drops the first `offset`
	 * sessions, which is fine at the volumes an org's agent traffic reaches
	 * (~10k index rows a day) and lets the client keep a single ordered list
	 * without a session-keyed cursor the aggregation cannot cheaply seek to.
	 */
	offset: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
	// Both filters land on the session-detection subquery, so `serviceNames`
	// means "the session-bearing spans came from this service", not "the trace
	// touched it" — see `aiSessionListQuery`.
	vendorIds: Schema.optional(Schema.Array(Schema.String)),
	serviceNames: Schema.optional(Schema.Array(Schema.String)),
}) {}

export const AiSessionListItem = Schema.Struct({
	/** The vendor's own session id, or `trace:<TraceId>` for an agent trace whose
	 *  vendor exposes no session key — see `MAPLE_AI_TRACE_SESSION_PREFIX`. */
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
	/**
	 * The framework's own session id, verbatim — `maple_ai.session.id` — or the
	 * `trace:<TraceId>` id Maple synthesizes for a GenAI trace that carries none
	 * (`MAPLE_AI_TRACE_SESSION_PREFIX`). The handler routes on the prefix and
	 * validates the trace id behind it; a prefixed id that is not one reads as a
	 * session nothing carries, which answers empty like any unknown id.
	 */
	sessionId: Schema.String.check(Schema.isMinLength(1)),
	// Optional, and the two halves are read as a pair — supply both or neither.
	//
	// With a window the read is partition-pruned on both levels (detection and
	// fan-out), which is the fast path every link from the list page takes: the
	// row already knows the session's own bounds, so it hands them over.
	//
	// Without one the handler resolves the session's bounds from the id first and
	// then runs the same pruned read. That resolve step is viable rather than
	// reckless where the fan-out would not be: `traces` carries a
	// `bloom_filter(0.01)` skip index over `mapValues(SpanAttributes)` for the id
	// to prune with, and its TTL caps any scan at 30 days. It still costs an
	// extra round trip and still degrades as an org's volume grows, so this is
	// the exception path for hint-less deep links — a pasted id, an MCP answer —
	// and not the default. The client is expected to write the bounds it got back
	// into its URL, which makes the second load of any such link the direct one.
	startTime: Schema.optionalKey(TinybirdDateTime),
	endTime: Schema.optionalKey(TinybirdDateTime),
}) {}

/**
 * Every `gen_ai.*` value the integration layer decoded off the span, one
 * optional key per catalog field. Generated from `AI_GENAI_FIELDS`, so the
 * wire shape and the decoder read the same list.
 */
export const AiSessionGenAiValues = AiGenAiValuesSchema
export type AiSessionGenAiValues = Schema.Schema.Type<typeof AiSessionGenAiValues>

/**
 * One span of a session, already normalized onto Maple's standard AI span
 * shape. The raw attribute maps the query reads are the bulk of that read and
 * are dropped server-side, so what lands here is the decoded view alone.
 */
export const AiSessionSpan = AiAgentSpanSchema
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
 * Row ceiling for one session's spans. The handler asks the query for one row
 * past it, so an exactly-full session is distinguishable from a truncated one.
 */
export const AI_SESSION_SPANS_MAX_SPANS = 2_000

/**
 * Response ceiling for one session's spans, measured over the warehouse rows —
 * which still carry the raw attribute maps, in production ~17KB on a single
 * agent span.
 *
 * The byte counter accumulates over rows that are already parsed, so the
 * ceiling only trips once that much of the JS object graph is resident: it has
 * to sit far below the 128MB isolate heap, not near it. Replay events get 8MB
 * for opaque strings; 10MB here because these rows are attribute-map-heavy, and
 * `AI_SESSION_SPANS_MAX_SPANS` bounds the ordinary session well before this
 * does.
 *
 * For a pathologically attribute-heavy session the byte cap fires first and the
 * request 413s instead of truncating. That is the designed outcome — the
 * alternative is an OOM that takes the isolate with it.
 */
export const MAX_AI_SESSION_SPANS_RESPONSE_BYTES = 10_000_000

/**
 * The session's spans exceed `MAX_AI_SESSION_SPANS_RESPONSE_BYTES`.
 *
 * Distinct from the row cap, which truncates and reports `truncated: true`: the
 * byte ceiling aborts the read before a response can be materialized, so there
 * is nothing to return. The endpoint takes no size parameter, but it does take
 * a window, and when one is supplied both the session detection and the span
 * fan-out are bounded by it — so a narrower range genuinely returns fewer
 * bytes, which is what `recovery: "fix_request"` points the caller at.
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
		message:
			"This session's spans are too large to return in one response. Open it from the Agent Sessions list, or narrow the time range.",
		retry: "never",
		recovery: "fix_request",
		exposure: "redacted",
	},
) {}

export class AiSessionsInternalApiGroup extends HttpApiGroup.make("aiSessionsInternal")
	.add(
		HttpApiEndpoint.post("list", "/list", {
			payload: ListAiSessionsRequest,
			success: ListAiSessionsResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("facets", "/facets", {
			payload: ListAiSessionsFacetsRequest,
			success: ListAiSessionsFacetsResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("spans", "/spans", {
			payload: GetAiSessionSpansRequest,
			success: GetAiSessionSpansResponse,
			error: [...warehouseReadHttpErrors, AiSessionTooLargeError],
		}),
	)
	.prefix("/internal/ai-sessions")
	.middleware(SessionAuthorization) {}
