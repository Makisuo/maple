import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { SessionId, TraceId, UserId } from "../primitives"
import { TinybirdDateTime } from "../query-engine"
import { Authorization } from "./current-tenant"
import { QueryEngineExecutionError, QueryEngineTimeoutError } from "./query-engine"
import { warehouseHttpErrors } from "./warehouse"

// Session replay endpoint schemas
//
// Backed by the session_replays (metadata) + session_replay_events (chunk index)
// datasources in ClickHouse. `getReplayEvents` returns the rrweb event arrays
// inline; the API hydrates them from R2 first when the row is blob-backed, so
// the wire shape is the same either way — no signed URLs, no client-side fetch.

export class ListReplaysRequest extends Schema.Class<ListReplaysRequest>("ListReplaysRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	// Optional filters are constructed JS-side by the web/MCP clients, which pass
	// `undefined` for any unset filter. `Schema.optional` accepts an explicit
	// `undefined` (key present, value undefined); `Schema.optionalKey` would
	// reject it and throw "Expected string, got undefined" at construction time,
	// before the request is ever sent. See CLAUDE.md (optional vs optionalKey).
	serviceName: Schema.optional(Schema.String),
	browser: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	// Plain string (not the branded UserId) — matches the other optional filters and
	// avoids brand validation rejecting partial input the client constructs JS-side.
	userId: Schema.optional(Schema.String),
	/** Substring match on the identified user's name or email (one input, both columns). */
	userSearch: Schema.optional(Schema.String),
	/** Exact match on the identified group (company / team) name. */
	groupName: Schema.optional(Schema.String),
	/** Every session from one browser — how a marketing visit links to a signup. */
	visitorId: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Boolean),
	search: Schema.optional(Schema.String),
	cursor: Schema.optional(Schema.String),
	// Session-time range filters (ms). `durationMin/Max` filter the stored
	// wall-clock duration; `activeTimeMin/Max` filter active (non-idle) time
	// computed from session_events gaps (server-side: setting either active bound
	// joins the activity aggregate). All four are JS-constructed → Schema.optional.
	durationMinMs: Schema.optional(Schema.Number),
	durationMaxMs: Schema.optional(Schema.Number),
	activeTimeMinMs: Schema.optional(Schema.Number),
	activeTimeMaxMs: Schema.optional(Schema.Number),
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
}) {}

export const SessionReplayListItem = Schema.Struct({
	sessionId: SessionId,
	startTime: Schema.String,
	endTime: Schema.NullOr(Schema.String),
	durationMs: Schema.NullOr(Schema.Number),
	status: Schema.String,
	userId: Schema.NullOr(UserId),
	// identify() identity. `""` when the session was never identified (including
	// every session recorded before the SDK had identify()) — the list falls back
	// to its session-id/host line, so an empty value is a display state, not a gap.
	userName: Schema.String,
	userEmail: Schema.String,
	groupId: Schema.String,
	groupName: Schema.String,
	/** Persistent per-browser id — equal across a visitor's marketing and app sessions. */
	visitorId: Schema.String,
	/** Acquisition source captured at session start; `""` when there was none. */
	utmSource: Schema.String,
	/** Entry pathname (no query/hash). Note `urlInitial` is the *latest* URL. */
	entryPath: Schema.String,
	urlInitial: Schema.String,
	browserName: Schema.String,
	osName: Schema.String,
	deviceType: Schema.String,
	country: Schema.String,
	serviceName: Schema.String,
	pageViews: Schema.Number,
	clickCount: Schema.Number,
	errorCount: Schema.Number,
	traceCount: Schema.Number,
	/** The SDK's `maple.session.recorded` marker. `"true"` / `"false"`, or `""`
	 *  for sessions written before the SDK stamped it — treat that as unknown,
	 *  not as "not recorded". */
	recorded: Schema.String,
})

export class ListReplaysResponse extends Schema.Class<ListReplaysResponse>("ListReplaysResponse")({
	data: Schema.Array(SessionReplayListItem),
}) {}

export class ReplaysFacetsRequest extends Schema.Class<ReplaysFacetsRequest>("ReplaysFacetsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	// Same optional-filter contract as ListReplaysRequest — see the note there.
	serviceName: Schema.optional(Schema.String),
	browser: Schema.optional(Schema.String),
	country: Schema.optional(Schema.String),
	deviceType: Schema.optional(Schema.String),
	userId: Schema.optional(Schema.String),
	userSearch: Schema.optional(Schema.String),
	groupName: Schema.optional(Schema.String),
	hasErrors: Schema.optional(Schema.Boolean),
	search: Schema.optional(Schema.String),
}) {}

export const ReplayFacetItem = Schema.Struct({
	name: Schema.String,
	count: Schema.Number,
})

export class ReplaysFacetsResponse extends Schema.Class<ReplaysFacetsResponse>("ReplaysFacetsResponse")({
	services: Schema.Array(ReplayFacetItem),
	browsers: Schema.Array(ReplayFacetItem),
	countries: Schema.Array(ReplayFacetItem),
	devices: Schema.Array(ReplayFacetItem),
	/** Identified groups (company / team), by session count. Empty for orgs that
	 *  never call `identify()` with a group — the sidebar hides the section then. */
	groups: Schema.Array(ReplayFacetItem),
	/** Distinct sessions with at least one recorded error, within the current filter. */
	errorCount: Schema.Number,
	/** Session-length distribution: `name` is the bucket floor in ms, `count` the
	 *  sessions in it. Buckets are half-octaves from 1s, so each ceiling is
	 *  floor × √2. Unordered — the client sorts numerically. */
	durationBuckets: Schema.Array(ReplayFacetItem),
	/** Session-length percentiles (ms) over the same population as the buckets;
	 *  0 when no completed session falls in the window. */
	durationP50: Schema.Number,
	durationP95: Schema.Number,
}) {}

export class GetReplayRequest extends Schema.Class<GetReplayRequest>("GetReplayRequest")({
	sessionId: SessionId,
	// Optional session time window — lets the warehouse prune daily partitions
	// instead of scanning the full 30-day retention. The web client derives it
	// from the `t` (session start) navigation hint; deep-links omit it and fall
	// back to a full scan. `Schema.optional` (not `optionalKey`) because the
	// client constructs the payload JS-side and passes explicit `undefined`.
	windowStart: Schema.optional(TinybirdDateTime),
	windowEnd: Schema.optional(TinybirdDateTime),
}) {}

export class GetReplayResponse extends Schema.Class<GetReplayResponse>("GetReplayResponse")({
	data: Schema.NullOr(
		Schema.Struct({
			sessionId: SessionId,
			startTime: Schema.String,
			endTime: Schema.NullOr(Schema.String),
			durationMs: Schema.NullOr(Schema.Number),
			status: Schema.String,
			userId: Schema.NullOr(UserId),
			urlInitial: Schema.String,
			userAgent: Schema.String,
			browserName: Schema.String,
			osName: Schema.String,
			deviceType: Schema.String,
			country: Schema.String,
			serviceName: Schema.String,
			pageViews: Schema.Number,
			clickCount: Schema.Number,
			errorCount: Schema.Number,
			traceIds: Schema.Array(TraceId),
			resourceAttributes: Schema.String,
			// Analytics dimensions (migration 0011). `visitorId` is the cross-surface
			// join key; the rest answer "who was this and where did they come from".
			visitorId: Schema.String,
			visitorIsNew: Schema.Boolean,
			userEmail: Schema.String,
			userName: Schema.String,
			groupId: Schema.String,
			groupName: Schema.String,
			/** `identify()` traits, JSON-encoded `Record<string, string>`. */
			userTraits: Schema.String,
			referrer: Schema.String,
			/** Gateway-normalized referrer host; `""` is direct *or* suppressed. */
			referrerHost: Schema.String,
			utmSource: Schema.String,
			utmMedium: Schema.String,
			utmCampaign: Schema.String,
			utmTerm: Schema.String,
			utmContent: Schema.String,
			host: Schema.String,
			entryPath: Schema.String,
			exitPath: Schema.String,
			language: Schema.String,
			/** Heartbeat-refreshed; recovers duration when the tab died without an unload. */
			lastActivityAt: Schema.NullOr(Schema.String),
			// Active/idle breakdown from session_events gaps (null when the session
			// has no distilled events). active + idle ≈ event span ≤ durationMs.
			activeTimeMs: Schema.NullOr(Schema.Number),
			idleTimeMs: Schema.NullOr(Schema.Number),
		}),
	),
}) {}

// Replay chunk payloads are not served here — see the API group below.

export class ReplaysForTraceRequest extends Schema.Class<ReplaysForTraceRequest>("ReplaysForTraceRequest")({
	traceId: TraceId,
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
}) {}

export class ReplaysForTraceResponse extends Schema.Class<ReplaysForTraceResponse>("ReplaysForTraceResponse")(
	{
		data: Schema.Array(
			Schema.Struct({
				sessionId: SessionId,
				startTime: Schema.String,
				durationMs: Schema.NullOr(Schema.Number),
			}),
		),
	},
) {}

export class SessionTraceSummariesRequest extends Schema.Class<SessionTraceSummariesRequest>(
	"SessionTraceSummariesRequest",
)({
	/** The session's correlated trace ids (from the detail response's `traceIds`). */
	traceIds: Schema.Array(TraceId),
	// See GetReplayRequest — optional partition-pruning window (the session's
	// time span; its correlated traces fired within it).
	windowStart: Schema.optional(TinybirdDateTime),
	windowEnd: Schema.optional(TinybirdDateTime),
}) {}

export const SessionTraceSummary = Schema.Struct({
	traceId: TraceId,
	startTime: Schema.String,
	durationMs: Schema.Number,
	rootSpanName: Schema.String,
	rootServiceName: Schema.String,
	/** Root span's OTel kind — lets the UI format the canonical HTTP label. */
	rootSpanKind: Schema.optionalKey(Schema.String),
	/** Root span's attribute map, JSON-encoded — parsed by the UI for `getHttpInfo`. */
	rootSpanAttributes: Schema.optionalKey(Schema.String),
	spanCount: Schema.Number,
	hasError: Schema.Number,
})

export class SessionTraceSummariesResponse extends Schema.Class<SessionTraceSummariesResponse>(
	"SessionTraceSummariesResponse",
)({
	data: Schema.Array(SessionTraceSummary),
}) {}

export class SessionTranscriptRequest extends Schema.Class<SessionTranscriptRequest>(
	"SessionTranscriptRequest",
)({
	sessionId: SessionId,
	// See GetReplayRequest — optional partition-pruning window.
	windowStart: Schema.optional(TinybirdDateTime),
	windowEnd: Schema.optional(TinybirdDateTime),
}) {}

export const SessionEventItem = Schema.Struct({
	timestamp: Schema.String,
	seq: Schema.Number,
	type: Schema.String,
	url: Schema.String,
	traceId: Schema.NullOr(TraceId),
	level: Schema.String,
	message: Schema.String,
	targetSelector: Schema.String,
	targetText: Schema.String,
	netMethod: Schema.String,
	netUrl: Schema.String,
	netStatus: Schema.Number,
	netDurationMs: Schema.Number,
	errorStack: Schema.String,
	/** `track()` props for a `custom` event, JSON-encoded `Record<string, string>`. */
	attributes: Schema.String,
})

export class SessionTranscriptResponse extends Schema.Class<SessionTranscriptResponse>(
	"SessionTranscriptResponse",
)({
	data: Schema.Array(SessionEventItem),
}) {}

// API group

const sessionReplayEndpointErrors = [
	QueryEngineExecutionError,
	QueryEngineTimeoutError,
	...warehouseHttpErrors,
] as const

export class SessionReplaysApiGroup extends HttpApiGroup.make("sessionReplays")
	.add(
		HttpApiEndpoint.post("listReplays", "/list", {
			payload: ListReplaysRequest,
			success: ListReplaysResponse,
			error: sessionReplayEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("facets", "/facets", {
			payload: ReplaysFacetsRequest,
			success: ReplaysFacetsResponse,
			error: sessionReplayEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("getReplay", "/get", {
			payload: GetReplayRequest,
			success: GetReplayResponse,
			error: sessionReplayEndpointErrors,
		}),
	)
	// Replay payload reads live on v2 only: `GET /v2/session_replays/:id/manifest`
	// then `GET /v2/session_replays/:id/events?from_chunk_seq=…`. There is no v1
	// equivalent on purpose — the v1 endpoint fetched a whole session's rrweb
	// payload in one unbounded response, which is the bug, and keeping a second
	// surface would have kept a way to reintroduce it.
	.add(
		HttpApiEndpoint.post("replaysForTrace", "/for-trace", {
			payload: ReplaysForTraceRequest,
			success: ReplaysForTraceResponse,
			error: sessionReplayEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("traceSummaries", "/trace-summaries", {
			payload: SessionTraceSummariesRequest,
			success: SessionTraceSummariesResponse,
			error: sessionReplayEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("sessionTranscript", "/transcript", {
			payload: SessionTranscriptRequest,
			success: SessionTranscriptResponse,
			error: sessionReplayEndpointErrors,
		}),
	)
	.prefix("/api/session-replays")
	.middleware(Authorization) {}
