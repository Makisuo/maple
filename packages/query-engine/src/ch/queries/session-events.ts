// ---------------------------------------------------------------------------
// Typed Session Event Queries
//
// DSL-based queries over the session_events datasource — the distilled,
// structured event stream (navigation/click/input/console/network/error)
// captured client-side by the @maple-dev/browser SDK. Powers the in-session search
// + transcript surfaced to humans (replay panels) and agents (MCP tools).
//
// Plain MergeTree, immutable append; no ReplacingMergeTree dedup needed.
// ---------------------------------------------------------------------------

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { compileFnCall } from "@maple-dev/clickhouse-builder"
import { param } from "@maple-dev/clickhouse-builder"
import { from, fromQuery, type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import { SessionEvents } from "../tables"

function count(): CH.Expr<number> {
	return compileFnCall<number>("count")
}

// ---------------------------------------------------------------------------
// Transcript: every event for one session, in order
//
// (OrgId, SessionId) is the sort-key prefix, so this is a contiguous range
// scan. Timestamp + Seq give a stable playback/reading order.
//
// session_events is PARTITION BY toDate(Timestamp) with a 30-day TTL; without a
// Timestamp predicate ClickHouse reads the primary index of every daily
// partition. The optional startTime/endTime bounds (the session's time window)
// prune to the 1-2 partitions the session spans. Omit to scan all.
// ---------------------------------------------------------------------------

export interface SessionTranscriptOutput {
	readonly timestamp: string
	readonly seq: number
	readonly type: string
	readonly url: string
	readonly traceId: string
	readonly level: string
	readonly message: string
	readonly targetSelector: string
	readonly targetText: string
	readonly netMethod: string
	readonly netUrl: string
	readonly netStatus: number
	readonly netDurationMs: number
	readonly errorStack: string
}

export interface SessionTranscriptOpts {
	/** Restrict to these event types (navigation/click/input/console/network/error). */
	types?: readonly string[]
	/** Only events that occurred under this trace id. */
	traceId?: string
	/** Only "things that went wrong": error events, console errors, and failed (>=400) requests. */
	errorsOnly?: boolean
	/** Optional session time window — prunes daily partitions. Omit to scan all. */
	startTime?: string
	endTime?: string
	/** Page size. Transcripts are unbounded otherwise — always cap for agents. */
	limit?: number
	offset?: number
}

export function sessionTranscriptQuery(opts: SessionTranscriptOpts = {}) {
	return from(SessionEvents)
		.select(($) => ({
			timestamp: $.Timestamp,
			seq: $.Seq,
			type: $.Type,
			url: $.Url,
			traceId: $.TraceId,
			level: $.Level,
			message: $.Message,
			targetSelector: $.TargetSelector,
			targetText: $.TargetText,
			netMethod: $.NetMethod,
			netUrl: $.NetUrl,
			netStatus: $.NetStatus,
			netDurationMs: $.NetDurationMs,
			errorStack: $.ErrorStack,
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.SessionId.eq(param.string("sessionId")),
			CH.when(opts.startTime, (v: string) => $.Timestamp.gte(v)),
			CH.when(opts.endTime, (v: string) => $.Timestamp.lte(v)),
			opts.types && opts.types.length > 0 ? CH.inList($.Type, opts.types) : undefined,
			CH.when(opts.traceId, (v: string) => $.TraceId.eq(v)),
			CH.whenTrue(opts.errorsOnly, () =>
				$.Type.eq("error")
					.or($.Type.eq("console").and($.Level.eq("error")))
					.or($.Type.eq("network").and($.NetStatus.gte(400))),
			),
		])
		.orderBy(["timestamp", "asc"], ["seq", "asc"])
		.limit(opts.limit ?? 100)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Event-match semi-join: sessions whose distilled events match the predicates
//
// Row-level filters are ANDed, so callers pass a coherent predicate set (e.g.
// type="network" + minStatus=500, or messageSearch="…"). Returns one row per
// matching session with the match count — an UNFORMATTED grouped builder used as
// an INNER JOIN by `sessionReplaysListQuery` to refine the (session_replays)
// session list by what happened inside each session. Binds the same
// orgId/startTime/endTime params as the list query (same pattern as
// `sessionActivityAggregateQuery`), so they resolve to one window when compiled
// together. No limit/offset/format — those belong to the outer list query.
// ---------------------------------------------------------------------------

export interface SessionEventMatchOpts {
	type?: string
	level?: string
	/** Network status >= this (e.g. 500 for server errors). */
	minStatus?: number
	/** Substring match on the event URL (page or request). */
	urlSearch?: string
	/** Substring match on console/error message text. */
	messageSearch?: string
	traceId?: string
}

export function sessionEventMatchQuery(opts: SessionEventMatchOpts) {
	return from(SessionEvents)
		.select(($) => ({
			sessionId: $.SessionId,
			matchCount: count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.when(opts.type, (v: string) => $.Type.eq(v)),
			CH.when(opts.level, (v: string) => $.Level.eq(v)),
			CH.when(opts.minStatus, (v: number) => $.NetStatus.gte(v)),
			CH.when(opts.urlSearch, (v: string) => $.Url.ilike(`%${v}%`)),
			CH.when(opts.messageSearch, (v: string) => $.Message.ilike(`%${v}%`)),
			CH.when(opts.traceId, (v: string) => $.TraceId.eq(v)),
		])
		.groupBy("sessionId")
}

// ---------------------------------------------------------------------------
// Active / idle time, computed from gaps between distilled events
//
// A session's wall-clock duration overstates engagement: a 30s interaction left
// open in a background tab for 45 minutes reports 45:00. We approximate *active*
// time from `session_events` — the distilled semantic stream (click / nav /
// input / console / network / error) — by walking consecutive events per
// session (ordered by Timestamp, Seq) and measuring the gap to the previous one:
//
//   activeTimeMs = Σ gap where 0 < gap ≤ IDLE_GAP_THRESHOLD_MS  (engaged)
//   idleTimeMs   = Σ gap where gap > IDLE_GAP_THRESHOLD_MS       (idle stretch)
//
// (active + idle ≈ last − first event timestamp; both ≤ wall-clock DurationMs.)
//
// The first event of each session has no predecessor — `lagInFrame`'s default is
// the row's own Timestamp, so its gap is 0 and counts as neither active nor idle.
//
// IDLE_GAP_THRESHOLD_MS is deliberately larger than the rrweb player's 2s idle
// threshold (replay-timeline.ts): `session_events` are sparse semantic events
// (no continuous mouse-move samples), so a 2s threshold would flag nearly every
// gap as idle. 15s is a heuristic — tune if it proves too coarse/fine.
// ---------------------------------------------------------------------------

/** Gaps longer than this (ms) between distilled events count as idle, not active. */
export const IDLE_GAP_THRESHOLD_MS = 15_000

export interface SessionActivityOutput {
	readonly sessionId: string
	readonly activeTimeMs: number
	readonly idleTimeMs: number
	readonly eventCount: number
}

export interface SessionActivityOpts {
	/** Optional session time window — prunes daily partitions. Omit to scan all. */
	startTime?: string
	endTime?: string
}

// Per-event gap (ms) to the previous distilled event in the same session.
// dateTime64(9) subtraction via nanos, matching the metrics rate query's
// lagInFrame pattern. Shared by the single-session and aggregate variants.
function sessionGapSelect($: ColumnAccessor<typeof SessionEvents.columns>) {
	const onePrecedingFrame = CH.windowSpec({
		partitionBy: [$.SessionId],
		orderBy: [
			[$.Timestamp, "asc"],
			[$.Seq, "asc"],
		],
		frame: CH.rowsBetween(CH.preceding(1), CH.currentRow),
	})
	const previousTimestamp = CH.over(CH.lagInFrame($.Timestamp, 1, $.Timestamp), onePrecedingFrame)
	return {
		sessionId: $.SessionId,
		gapMs: CH.toFloat64(
			CH.toUnixTimestamp64Nano($.Timestamp).sub(CH.toUnixTimestamp64Nano(previousTimestamp)),
		).div(1_000_000),
	}
}

// Aggregate per-session gaps into active / idle totals. Generic over the inner
// gap subquery so both variants share the threshold split.
function activeIdleAggregate(inner: ReturnType<typeof sessionActivityGaps>) {
	return fromQuery(inner, "g")
		.select(($) => ({
			sessionId: $.sessionId,
			activeTimeMs: CH.sumIf($.gapMs, $.gapMs.gt(0).and($.gapMs.lte(IDLE_GAP_THRESHOLD_MS))),
			idleTimeMs: CH.sumIf($.gapMs, $.gapMs.gt(IDLE_GAP_THRESHOLD_MS)),
			eventCount: count(),
		}))
		.groupBy("sessionId")
}

function sessionActivityGaps(opts: { single: boolean } & SessionActivityOpts) {
	return from(SessionEvents)
		.select(sessionGapSelect)
		.where(($) =>
			opts.single
				? [
						$.OrgId.eq(param.string("orgId")),
						$.SessionId.eq(param.string("sessionId")),
						CH.when(opts.startTime, (v: string) => $.Timestamp.gte(v)),
						CH.when(opts.endTime, (v: string) => $.Timestamp.lte(v)),
					]
				: [
						$.OrgId.eq(param.string("orgId")),
						$.Timestamp.gte(param.dateTime("startTime")),
						$.Timestamp.lte(param.dateTime("endTime")),
					],
		)
}

// Single session (detail page + MCP get_session_traces). Binds `sessionId` as a
// param; optional startTime/endTime hints prune daily partitions.
export function sessionActivityQuery(opts: SessionActivityOpts = {}) {
	return activeIdleAggregate(sessionActivityGaps({ single: true, ...opts }))
		.limit(1)
		.format("JSON")
}

// Every session in the org + time window, keyed by sessionId. Returned as an
// unformatted builder so the replays list query can LEFT JOIN it to filter by
// active time. Binds the same `startTime`/`endTime` params as the list query, so
// they resolve to the same window when compiled together.
export function sessionActivityAggregateQuery() {
	return activeIdleAggregate(sessionActivityGaps({ single: false }))
}
