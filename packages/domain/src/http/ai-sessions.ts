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

/** Which of a session's spans a read returns. `ai` is the vendor-stamped
 *  spans alone — the transcript's whole input — and `app` is the complement,
 *  the service's own HTTP/DB work sharing the agent's traces. */
export const AiSessionSpanScope = Schema.Literals(["all", "ai", "app"])
export type AiSessionSpanScope = Schema.Schema.Type<typeof AiSessionSpanScope>

/**
 * Keyset position in a session's span order (`timestamp`, then `spanId`). Both
 * values are copied from the last span of the previous page: the timestamp is
 * the warehouse literal at nanosecond precision, which is what makes the pair
 * unique — agent spans routinely share a millisecond.
 */
export const AiSessionSpanCursor = Schema.Struct({
	timestamp: TinybirdDateTime,
	spanId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
})
export type AiSessionSpanCursor = Schema.Schema.Type<typeof AiSessionSpanCursor>

const TraceIdHex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/))

/** Traces one span read may be pinned to — a turn's worth, not a session's. */
export const AI_SESSION_SPANS_MAX_TRACE_IDS = 100

/**
 * Row ceiling for one page of a session's spans. The handler asks the query for
 * one row past it, so an exactly-full page is distinguishable from one with a
 * page after it.
 */
export const AI_SESSION_SPANS_MAX_SPANS = 2_000

export class GetAiSessionSpansRequest extends Schema.Class<GetAiSessionSpansRequest>(
	"GetAiSessionSpansRequest",
)(
	Schema.Struct({
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
	/** Defaults to `all`. */
	scope: Schema.optionalKey(AiSessionSpanScope),
	/** Spans strictly after this position; absent for the first page. */
	after: Schema.optionalKey(AiSessionSpanCursor),
	/**
	 * Read these traces of the session instead of resolving the session's
	 * traces — the per-turn read the detail page makes for a turn's `app`
	 * spans, where the turn already knows which traces it spans. Requires the
	 * window, which is what bounds the read; the session id is then only the
	 * span the request is annotated with.
	 */
	traceIds: Schema.optionalKey(Schema.Array(TraceIdHex).check(Schema.isMaxLength(AI_SESSION_SPANS_MAX_TRACE_IDS))),
	/** Page size, at most `AI_SESSION_SPANS_MAX_SPANS` (the default). */
	limit: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: AI_SESSION_SPANS_MAX_SPANS })),
	),
	}).check(
		// The window is what bounds a trace-pinned read, and the session id
		// cannot stand in for it: resolving the SESSION's bounds for traces named
		// outright is a round trip that answers empty for a session nothing
		// carries. Checked here so the miss is a 400 rather than an empty page.
		Schema.makeFilter(
			(request: { readonly traceIds?: readonly string[]; readonly startTime?: string; readonly endTime?: string }) =>
				request.traceIds === undefined ||
				(request.startTime !== undefined && request.endTime !== undefined) ||
				"traceIds requires startTime and endTime",
			{ identifier: "TraceIdsNeedWindow" },
		),
	),
) {}

export class GetAiSessionSummaryRequest extends Schema.Class<GetAiSessionSummaryRequest>(
	"GetAiSessionSummaryRequest",
)({
	/** As on `GetAiSessionSpansRequest`, including the `trace:` form. */
	sessionId: Schema.String.check(Schema.isMinLength(1)),
	/** As on `GetAiSessionSpansRequest`: both or neither. */
	startTime: Schema.optionalKey(TinybirdDateTime),
	endTime: Schema.optionalKey(TinybirdDateTime),
}) {}

export const AiSessionTokenTotals = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	cacheRead: Schema.Number,
})
export type AiSessionTokenTotals = Schema.Schema.Type<typeof AiSessionTokenTotals>

/**
 * How a session's usage was reported, which decides which spans' figures the
 * totals sum. `per-call`: the model-call spans carry usage, and the totals are
 * theirs alone — an agent span that also carries a roll-up of its children is
 * not added on top. `roll-up`: no model-call span reported anything, so the
 * totals are what the wrapping spans reported. `none`: nothing did.
 */
export const AiSessionTokenReporting = Schema.Literals(["per-call", "roll-up", "none"])
export type AiSessionTokenReporting = Schema.Schema.Type<typeof AiSessionTokenReporting>

/**
 * One turn of a session as the warehouse groups it: by `gen_ai.conversation.id`
 * (and the vendor spellings of it), falling back to the trace.
 *
 * The grouping sees one span at a time. A span that carries the id is the
 * turn's; a child that does not — a model call under a turn span that alone
 * was stamped — lands in its trace's row instead. The page's own turn model
 * walks parents and so places those children; these rows therefore sum to the
 * session exactly, but their count and their per-turn split are only as good
 * as the emitter's stamping. Session totals in the response are exact.
 */
export const AiSessionTurnSummary = Schema.Struct({
	turnKey: Schema.String,
	/** Empty when the turn is a trace with no conversation id. */
	conversationId: Schema.String,
	traceIds: Schema.Array(Schema.String),
	/** Warehouse datetime literals, like the list row's. */
	startTime: Schema.String,
	endTime: Schema.String,
	durationMs: Schema.Number,
	spanCount: Schema.Number,
	aiSpanCount: Schema.Number,
	llmCalls: Schema.Number,
	toolCalls: Schema.Number,
	errorSpanCount: Schema.Number,
	tokens: AiSessionTokenTotals,
	/** Absent when no span of the turn reported a cost. */
	cost: Schema.optionalKey(Schema.Number),
	models: Schema.Array(Schema.String),
	agentNames: Schema.Array(Schema.String),
})
export type AiSessionTurnSummary = Schema.Schema.Type<typeof AiSessionTurnSummary>

/** Turn rows one summary carries. A session grouping into more is summarised
 *  from its first rows alone and says so with `turnsTruncated`. */
export const AI_SESSION_SUMMARY_MAX_TURNS = 1_000

/**
 * The whole session's totals, computed in the warehouse — so they hold for a
 * session far larger than one spans response, which is the reason this exists.
 */
export class GetAiSessionSummaryResponse extends Schema.Class<GetAiSessionSummaryResponse>(
	"GetAiSessionSummaryResponse",
)({
	spanCount: Schema.Number,
	aiSpanCount: Schema.Number,
	traceCount: Schema.Number,
	/** Absent for an unknown session — one with no spans. */
	startTime: Schema.optionalKey(Schema.String),
	endTime: Schema.optionalKey(Schema.String),
	durationMs: Schema.Number,
	llmCalls: Schema.Number,
	toolCalls: Schema.Number,
	errorSpanCount: Schema.Number,
	tokens: AiSessionTokenTotals,
	tokenReporting: AiSessionTokenReporting,
	cost: Schema.optionalKey(Schema.Number),
	models: Schema.Array(Schema.String),
	agentNames: Schema.Array(Schema.String),
	turns: Schema.Array(AiSessionTurnSummary),
	turnsTruncated: Schema.Boolean,
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
	 * Where the next page starts; absent when this page ended the read. A page
	 * is the OLDEST spans not yet returned, so a client that stops paging holds
	 * the session's beginning and must say the end is missing rather than
	 * present what it has as a complete transcript.
	 */
	nextCursor: Schema.optionalKey(AiSessionSpanCursor),
}) {}

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
 * One page of the session's spans exceeds `MAX_AI_SESSION_SPANS_RESPONSE_BYTES`.
 *
 * Distinct from the row cap, which ends the page and hands back a cursor: the
 * byte ceiling aborts the read before a response can be materialized, so there
 * is nothing to return. A smaller `limit` is the direct fix, and a narrower
 * window bounds both the session detection and the span fan-out — either
 * genuinely returns fewer bytes, which is what `recovery: "fix_request"`
 * points the caller at.
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
			"This page of the session's spans is too large to return in one response. Ask for fewer spans per page, or narrow the time range.",
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
	.add(
		HttpApiEndpoint.post("summary", "/summary", {
			payload: GetAiSessionSummaryRequest,
			success: GetAiSessionSummaryResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.prefix("/internal/ai-sessions")
	.middleware(SessionAuthorization) {}
