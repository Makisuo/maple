// AI agent sessions — read side
//
// The ingest gateway stamps three attributes on AI-agent spans at decode time
// (`apps/ingest/src/ai_session.rs`): `maple_ai.vendor.id`,
// `maple_ai.vendor.version` and `maple_ai.session.id`. Only the last one is
// sparse — a vendor exposes a session key on the spans that own the turn
// (`ai.eve.turn`, `invoke_agent`), never on the sibling `chat`, `execute_tool`,
// `workflow.*` or HTTP-client spans it fans out to.
//
// So a session is resolved at TRACE granularity: a trace belongs to a session
// if ANY of its spans carries that session id, and then EVERY span of that
// trace is part of the session — including the completely non-AI ones. That is
// deliberate; the dashboard shows the full agent context, not just the spans
// the framework happened to label.
//
// A trace can carry no session id at all and still be an agent run: several
// vendors (haystack, litellm, llamaindex, semantic_kernel, effect_ai) expose no
// session key, and the `unknown:*` buckets never do. Those traces used to be
// invisible here. They are now sessions of one trace, keyed
// `trace:<TraceId>` (`MAPLE_AI_TRACE_SESSION_PREFIX`) — the same page, with the
// single trace as the whole context. That is why detection keys on the VENDOR
// stamp rather than the session one: the vendor id is on every span the gateway
// classified as GenAI, so it is the marker that finds both populations, and the
// session id becomes a grouping key rather than an admission test.
//
// Both queries are that fan-out, in two stages against two different tables:
//
//   detect  — `ai_trace_index`, the filtered projection holding ONLY the
//     vendor-stamped spans (~0.01% of rows), pre-extracted to plain columns by
//     `ai_trace_index_mv`. Detection used to run the vendor predicate against
//     raw `traces` behind the `mapKeys(SpanAttributes)` bloom skip index, and
//     that shape cannot be saved: GenAI spans arrive continuously — about one
//     per index granule at production volume — so the bloom prunes nothing and
//     the scan reads the fat Map column for EVERY span in the window. Measured
//     2026-08-29 in production: ~3.6s for a one-hour window, dead at the 15s
//     kill by a day. The index is the same predicate applied at insert time;
//     scanning it costs ~10k narrow rows per day. This stage yields the
//     qualifying trace-id set and nothing else.
//   fan out — `trace_detail_spans`, restricted by `TraceId IN (…)`. `TraceId` is
//     a sort-key prefix there (`(OrgId, TraceId, SpanId)`), so this is a seek.
//     The same fan-out against raw `traces` times out at 10s on a 7-day window
//     in production: that table is sorted `(OrgId, ServiceName, SpanName,
//     Timestamp)` and `idx_trace_id` is only a bloom skip index, which prunes
//     far too little at this org's volume.
//
// `IN` rather than a JOIN for the fan-out, the same reason
// `errorDetailTracesQuery` uses it — ClickHouse pushes the id set into the
// read, which a JOIN does not do.
//
// The index fills forward from its deploy: rows already in `traces` when the MV
// was created are not in it until a backfill runs, so detection (and the
// facets) can under-report windows that predate the deploy. The fan-out and the
// per-session reads still see every span of any trace detection finds.
//
// The window predicate sits on BOTH levels, and the fan-out's copy is PADDED
// rather than exact. That is what reconciles the two demands on it:
// `trace_detail_spans` is `PARTITION BY toDate(Timestamp)`, so the predicate is
// the only thing that prunes partitions there, while an exact copy of the
// window would clamp the reported start/end of every session that began before
// the range. A day of padding costs one extra partition on each side and
// contains any trace shorter than 24h.
//
// What omitting it costs is invisible warm and severe cold. Measured against
// production, one fixed set of 20 trace ids whose parts were not cached:
// 328ms with an exact window, 1,089ms with the padded one, 8,389ms with no
// predicate at all — while re-running all three against warm parts puts them
// within ~100ms of each other. Cold is the normal state of a dashboard query
// against a month of partitions, and the `list` profile kills it at 15s.
//
// A caller that has no window — a deep link carrying only a session id —
// resolves one with `aiSessionWindowQuery` first, rather than running the
// fan-out unpruned. That query still reads raw `traces`, and can: it prunes by
// the session id VALUE, which the `mapValues(SpanAttributes)` bloom index does
// serve (the id is rare), unlike the presence-of-key detection this file moved
// off `traces` — and the table's 30-day TTL bounds what is left.
//
// A `trace:` id needs neither the attribute detection nor the fan-out: it names
// the trace outright, so `aiTraceWindowQuery`/`aiTraceSpansQuery` are the same
// two reads with `TraceId = {traceId}` in place of the detection subquery —
// `idx_trace_id` on `traces` for the bounds, the `(OrgId, TraceId, SpanId)`
// sort key on `trace_detail_spans` for the spans.
//
// Tenant scoping: a subquery contributes nothing to the outer query's scope, so
// every level that reads a table repeats `OrgId = {orgId}` itself. The outermost
// level of `aiSessionListQuery` reads a derived table rather than a table, and
// inherits `org` scope from it.

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import {
	compileFnCall,
	from,
	fromQuery,
	inSubquery,
	param,
	unionAll,
	type CHUnionQuery,
	type ColumnAccessor,
	type CompiledQueryRowSchema,
} from "@maple-dev/clickhouse-builder"
import { AiTraceIndex, TraceDetailSpans, Traces } from "@maple/query-engine/ch/tables"
import { CHNumber } from "@maple/query-engine/ch/schema"
import { AI_SESSION_SPANS_MAX_SPANS } from "@maple/domain/http"
import {
	MAPLE_AI_SESSION_ID_ATTR,
	MAPLE_AI_TRACE_SESSION_PREFIX,
	MAPLE_AI_VENDOR_ID_ATTR,
	MAPLE_AI_VENDOR_VERSION_ATTR,
} from "@maple/domain/gen-ai"

const SESSION_ID_ATTR = MAPLE_AI_SESSION_ID_ATTR
const VENDOR_ID_ATTR = MAPLE_AI_VENDOR_ID_ATTR
const VENDOR_VERSION_ATTR = MAPLE_AI_VENDOR_VERSION_ATTR
const ERROR_TYPE_ATTR = "error.type"
const RESPONSE_STATUS_ATTR = "gen_ai.response.status"
/** `gen_ai.response.status` values that mean the generation failed — semconv's
 *  `failed` plus the pre-enum `error` dialect. Mirrors `spanFailed` in
 *  `apps/web/src/lib/agent-sessions/session-turns.ts`; the list badge and the
 *  detail's Failures panel must count the same spans. */
const FAILED_RESPONSE_STATUSES = ["failed", "error"]

/**
 * Sorts every span that is NOT session-bearing behind every one that is, so a
 * single `argMin`/`min` over it picks the earliest session-bearing span without
 * needing an `argMinIf` the DSL does not have. Wrapped in `toDateTime` rather
 * than left a bare string, or `if()` would have to reconcile DateTime64(9) with
 * String. That wrapper is also why the sentinel is 2106 and not 3000: `DateTime`
 * tops out at 2106-02-07 and anything past it fails to parse.
 */
const SESSION_ORDER_SENTINEL = "2106-01-01 00:00:00"

/**
 * How far past the caller's window the `trace_detail_spans` fan-out reads, in
 * seconds. See this file's header: the point is a predicate ClickHouse can
 * prune partitions with, not an exact bound, so the pad is chosen to be a whole
 * partition (`PARTITION BY toDate(Timestamp)`) and to contain any trace that
 * straddles the window edge.
 */
const FAN_OUT_PAD_SECONDS = 86_400

/** ClickHouse returns `''` for a missing Map key, so presence needs both halves. */
const hasSessionId = (attrs: CH.Expr<Record<string, string>>, get: CH.Expr<string>) =>
	CH.mapContains(attrs, SESSION_ID_ATTR).and(get.neq(""))

/** Not in the builder's function set; same local helper `tracesDetailQuery` uses. */
const fromUnixTimestamp64Nano = (nanos: CH.Expr<number>): CH.Expr<string> =>
	compileFnCall<string>("fromUnixTimestamp64Nano", nanos)

/** Lexicographic ordering key — ClickHouse compares tuples element by element,
 *  which is how one `argMin` expresses "lowest rank, then earliest". Not in the
 *  builder's function set, and never selected: it only ever orders an argMin. */
const orderTuple = (...parts: ReadonlyArray<unknown>): CH.Expr<unknown> =>
	compileFnCall<unknown>("tuple", ...parts)

/**
 * The session id a trace is filed under: the vendor's own where it has one,
 * else `trace:<TraceId>` — a session of exactly this one trace.
 *
 * Reads the per-trace derived table rather than raw spans, because
 * sessionless-ness is a property of the TRACE and not of the span: most spans of
 * a session-bearing trace carry no session id themselves, and keying on that
 * would file each of them as its own sessionless trace.
 */
const sessionKey = (rawSessionId: CH.Expr<string>, traceId: CH.Expr<string>): CH.Expr<string> =>
	CH.if_(rawSessionId.eq(""), CH.concat(MAPLE_AI_TRACE_SESSION_PREFIX, traceId), rawSessionId)

export interface AiSessionListOpts {
	/** Sessions returned, most recently started first. */
	readonly limit?: number
	/** Sessions skipped before `limit` applies — the list's next page. */
	readonly offset?: number
	readonly vendorIds?: readonly string[]
	readonly serviceNames?: readonly string[]
}

export interface AiSessionListOutput {
	/** The vendor's own session id, or `trace:<TraceId>` for a trace that has
	 *  none — see `MAPLE_AI_TRACE_SESSION_PREFIX`. */
	readonly sessionId: string
	/** Vendor of the earliest session-bearing span — see `aiSessionListQuery`. */
	readonly vendorId: string
	readonly vendorVersion: string
	readonly traceCount: number
	readonly spanCount: number
	readonly errorSpanCount: number
	readonly serviceNames: readonly string[]
	/** ClickHouse datetime literal, e.g. `2026-08-19 10:33:25.825000000`. */
	readonly startTime: string
	readonly endTime: string
	readonly durationMs: number
}

/**
 * One row per AI agent session in the window.
 *
 * Detection admits any trace with a GenAI span, and the session id then groups
 * rather than admits: a trace that carries one is filed under it — with the
 * session's other traces — and a trace that carries none becomes a session of
 * its own, keyed `trace:<TraceId>`. Sessionless is the normal state for whole
 * vendors, not an edge case; see this file's header.
 *
 * `vendorId` is the vendor of the EARLIEST span that carries a session id, not
 * `max(vendorId)`. A single trace legitimately carries several vendors — an eve
 * agent calls through the Vercel AI SDK — and `max` picked `vercel_ai_sdk`
 * alphabetically over `eve` when `eve` was the framework actually running the
 * turn. The root-most session-bearing span is the one that names the framework,
 * so the two `argMin`s (per trace, then across traces) resolve to it. A trace
 * with no session-bearing span falls to the next rank of the same ordering —
 * its earliest vendor-stamped span, which is that trace's root-most agent span.
 *
 * The vendor filter goes on the detection subquery: it is the level the index
 * serves, and it is the only place `maple_ai.vendor.id` is unambiguous —
 * a trace's other spans carry other vendors, or none.
 *
 * The service filter goes there too, which means "the trace's agent spans came
 * from this service" rather than "the trace touched this service". A trace spans
 * services by definition, so the alternative — filtering the fan-out — would
 * silently drop spans and under-count `spanCount`. The agent spans come from the
 * agent's own service, which is the one a user filtering by service means.
 *
 * The time window bounds DETECTION exactly and the fan-out loosely. Once a trace
 * qualifies it is aggregated across the padded window rather than the caller's,
 * so `startTime`/`endTime`/`durationMs`/`spanCount`/`errorSpanCount`/
 * `serviceNames` describe the whole trace rather than the slice of it that fell
 * inside the range — a session that began an hour before the range no longer
 * reports the range edge as its start, and the detail page can read the bounds
 * this row carries as the session's own. A trace longer than `FAN_OUT_PAD_SECONDS`
 * is clamped again, which no observed trace comes close to.
 *
 * The remaining gap is between traces, not inside one: a session whose OTHER
 * traces lie entirely outside the range is still found only by the traces that
 * touched it, which needs a session-keyed table to fix and not a wider window.
 */
export function aiSessionListQuery(opts: AiSessionListOpts = {}) {
	const limit = opts.limit ?? 50
	const offset = opts.offset ?? 0

	// No vendor-presence predicate: `ai_trace_index_mv` admits only spans with a
	// non-empty vendor id, so membership in the table IS the detection predicate.
	const sessionTraceIds = from(AiTraceIndex)
		.select(($) => ({ TraceId: $.TraceId }))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
			opts.vendorIds?.length ? CH.inList($.VendorId, opts.vendorIds) : undefined,
			opts.serviceNames?.length ? CH.inList($.ServiceName, opts.serviceNames) : undefined,
		])

	// Per trace: every span of a qualifying trace, session-bearing or not. The
	// window is padded here rather than dropped, so "every span" means every span
	// the trace has, while the read still prunes to a handful of partitions.
	const perTrace = from(TraceDetailSpans)
		.select(($) => {
			const sessionOrder = CH.if_(
				hasSessionId($.SpanAttributes, $.SpanAttributes.get(SESSION_ID_ATTR)),
				$.Timestamp,
				CH.toDateTime(CH.lit(SESSION_ORDER_SENTINEL)),
			)
			// Ranks a trace's spans for the vendor `argMin`s: session-bearing first,
			// then merely vendor-stamped, then the rest, and inside each rank the
			// earliest. `sessionOrder` alone ties every span of a SESSIONLESS trace
			// at the sentinel, and argMin over ties is non-deterministic — it would
			// hand back whichever span ClickHouse read first, blank vendor included.
			const vendorOrder = orderTuple(
				CH.multiIf(
					[
						[hasSessionId($.SpanAttributes, $.SpanAttributes.get(SESSION_ID_ATTR)), CH.lit(0)],
						[$.SpanAttributes.get(VENDOR_ID_ATTR).neq(""), CH.lit(1)],
					],
					CH.lit(2),
				),
				$.Timestamp,
			)
			return {
				traceId: $.TraceId,
				// A trace belongs to one session; the non-bearing spans read `''`,
				// which `max` discards. Named apart from the outer `sessionId`: that
				// one is this value or a synthesized `trace:` id, and an alias that
				// referred to itself would be a cyclic alias rather than a fallback.
				rawSessionId: CH.max_($.SpanAttributes.get(SESSION_ID_ATTR)),
				vendorId: CH.argMin($.SpanAttributes.get(VENDOR_ID_ATTR), vendorOrder),
				vendorVersion: CH.argMin($.SpanAttributes.get(VENDOR_VERSION_ATTR), vendorOrder),
				// Carried so the outer level can order traces by their first
				// session-bearing span rather than by their first span of any kind.
				sessionStart: CH.min_(sessionOrder),
				spanCount: CH.count(),
				// Span status, or an attribute-declared failure on a vendor-stamped
				// span: frameworks record failed model/tool calls as values on `Ok`
				// spans, and the badge must agree with the detail page's counting.
				errorSpanCount: CH.countIf(
					$.StatusCode.eq("Error").or(
						$.SpanAttributes.get(VENDOR_ID_ATTR)
							.neq("")
							.and(
								$.SpanAttributes.get(ERROR_TYPE_ATTR)
									.neq("")
									.or(
										CH.inList(
											$.SpanAttributes.get(RESPONSE_STATUS_ATTR),
											FAILED_RESPONSE_STATUSES,
										),
									),
							),
					),
				),
				serviceNames: CH.groupUniqArray($.ServiceName),
				// Named apart from the outer `startTime`/`endTime` on purpose: an
				// outer alias shadows the derived table's column of the same name,
				// so `min(startTime)` would resolve to the outer `toString(…)` String
				// and `toUnixTimestamp64Nano` reject it — verified against production,
				// it fails with ILLEGAL_TYPE_OF_ARGUMENT.
				traceStart: CH.min_($.Timestamp),
				// `Timestamp` is the span's START, so `max(Timestamp)` is when the
				// last span BEGAN — the trace end is that span's start plus its own
				// duration. Without the `+ Duration` a session whose trace is a
				// single long span reports a duration of 0, and every other session
				// under-reports by exactly the last-starting span's duration, which
				// is invisible because it always looks like plausible jitter. Same
				// idiom as `tracesDetailQuery`.
				traceEndNanos: CH.max_(CH.toUnixTimestamp64Nano($.Timestamp).add(CH.toInt64($.Duration))),
			}
		})
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(CH.intervalSub(param.dateTimeString("startTime"), FAN_OUT_PAD_SECONDS)),
			$.Timestamp.lte(CH.intervalAdd(param.dateTimeString("endTime"), FAN_OUT_PAD_SECONDS)),
			inSubquery($.TraceId, sessionTraceIds),
		])
		.groupBy("traceId")

	const sessions = fromQuery(perTrace, "session_traces")
		.select(($) => ({
			// The grouping key, and the only level that can compute it: the
			// derived table is one row per trace, so a trace with no session id
			// of its own becomes a session of one trace here rather than joining
			// every other sessionless trace under `''`.
			sessionId: sessionKey($.rawSessionId, $.traceId),
			vendorId: CH.argMin($.vendorId, $.sessionStart),
			vendorVersion: CH.argMin($.vendorVersion, $.sessionStart),
			// `count()`, not `uniq()`: the derived table already emits exactly one
			// row per trace, so this is exact and cheaper — `uniq` is an
			// approximate HLL that would start drifting on a very large session.
			traceCount: CH.count(),
			spanCount: CH.sum($.spanCount),
			errorSpanCount: CH.sum($.errorSpanCount),
			serviceNames: CH.groupUniqArrayArray($.serviceNames),
			startTime: CH.toString_(CH.min_($.traceStart)),
			endTime: CH.toString_(fromUnixTimestamp64Nano(CH.max_($.traceEndNanos))),
			// Nanoseconds first: `Timestamp` is DateTime64(9), and subtracting two
			// of them yields a Decimal whose scale the wire format then quotes.
			// Wrapped in `intDiv` because `Expr.sub`/`div` do not parenthesize.
			durationMs: CH.intDiv(
				CH.max_($.traceEndNanos).sub(CH.toUnixTimestamp64Nano(CH.min_($.traceStart))),
				1_000_000,
			),
		}))
		// No `sessionId != ''` guard any more, and none needed: the key is never
		// empty. It used to keep two unrelated populations apart — a trace whose
		// session-bearing span has landed in `traces` but not yet in the
		// `trace_detail_spans` MV read back empty, and every such trace grouped
		// together under one blank session. Both now key on their own trace id.
		.groupBy("sessionId")
		.orderBy(["startTime", "desc"])
		.limit(limit)
	// Only a positive offset is emitted: `OFFSET 0` is a no-op that would still
	// change the compiled SQL of every first-page read.
	return (offset > 0 ? sessions.offset(offset) : sessions).format("JSON")
}

// List facets (UNION ALL — vendor / service)

export interface AiSessionFacetsOutput {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

/**
 * Distinct sessions per vendor and per service, for the list's filter sidebar.
 *
 * This is the detection scan of `aiSessionListQuery` (an `ai_trace_index` read)
 * and nothing else — no `trace_detail_spans` fan-out, which is the expensive
 * half. It can be: both of the list's filters are applied at that level, so the
 * population a facet describes is exactly the population its filter selects.
 *
 * What it cannot do is count per span. A session id is a fact about the TRACE,
 * so a facet keyed on the span's own value would count every agent span of a
 * session-bearing trace that lacks the id — most of them — as a separate
 * sessionless trace, and roughly double every number in the sidebar. Hence the
 * per-trace level: one row per trace carrying its key, with the facet's values
 * collected alongside and unnested by `arrayJoin` at the counting level.
 *
 * The counts stay ANY-span counts, matching the filter: a session belongs to
 * every vendor and every service that ANY of its agent spans carries, so a
 * session whose spans came from two vendors is counted under both and the facet
 * counts sum to more than the number of sessions. Picking one value returns
 * exactly the count shown.
 *
 * `uniqExact` rather than `uniq`: session counts are small enough that the exact
 * aggregate costs nothing, and the number has to agree with the list beside it.
 */
export function aiSessionFacetsQuery(): CHUnionQuery<AiSessionFacetsOutput> {
	const facet = (
		facetType: string,
		name: ($: ColumnAccessor<typeof AiTraceIndex.columns>) => CH.Expr<string>,
	) => {
		const perTrace = from(AiTraceIndex)
			.select(($) => ({
				traceId: $.TraceId,
				rawSessionId: CH.max_($.SessionId),
				names: CH.groupUniqArray(name($)),
			}))
			.where(($) => [
				// Every UNION ALL branch reads a table, so every branch carries the org
				// predicate itself — see this file's header.
				$.OrgId.eq(param.string("orgId")),
				$.Timestamp.gte(param.dateTimeString("startTime")),
				$.Timestamp.lte(param.dateTimeString("endTime")),
				// A blank option filters nothing and is not offered.
				name($).neq(""),
			])
			.groupBy("traceId")

		return fromQuery(perTrace, "facet_traces")
			.select(($) => ({
				name: CH.arrayJoin($.names),
				count: CH.uniqExact(sessionKey($.rawSessionId, $.traceId)),
				facetType: CH.lit(facetType),
			}))
			.groupBy("name")
			.orderBy(["count", "desc"])
			.limit(50)
	}

	return unionAll(
		facet("vendor", ($) => $.VendorId),
		facet("service", ($) => $.ServiceName),
	).format("JSON")
}

// Session window resolution (id → bounds)

export interface AiSessionWindowOutput {
	/** Warehouse datetime literals, already padded — feed them straight back in. */
	readonly startTime: string
	readonly endTime: string
	/** Zero means no such session, which the bounds cannot say on their own. */
	readonly spanCount: number
}

/**
 * The bounds of one session, for a caller that holds its id and nothing else.
 *
 * This is `aiSessionSpansQuery`'s detection half with the trace ids replaced by
 * an aggregate, and it is the one read in this file that legitimately runs with
 * no time predicate: `traces` carries a `bloom_filter(0.01)` skip index over
 * `mapValues(SpanAttributes)` for the id to prune with, and the table's 30-day
 * TTL caps what is left. The fan-out has neither and must not be run that way.
 *
 * The bounds come back padded by `FAN_OUT_PAD_SECONDS`, because they are
 * measured over the session-BEARING spans while the read they bound returns
 * every span of those spans' traces — a trace whose first span is not the
 * session-bearing one starts earlier than any window this could report exactly.
 *
 * `min`/`max` over no rows return the epoch rather than nothing, so a caller
 * must read `spanCount` to tell an unknown session from a real one.
 */
export function aiSessionWindowQuery() {
	return from(Traces)
		.select(($) => ({
			startTime: CH.toString_(CH.intervalSub(CH.min_($.Timestamp), FAN_OUT_PAD_SECONDS)),
			endTime: CH.toString_(CH.intervalAdd(CH.max_($.Timestamp), FAN_OUT_PAD_SECONDS)),
			spanCount: CH.count(),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			// Same presence guard as `aiSessionSpansQuery`, for the same reason: a
			// missing Map key reads back as `''`, so equality alone would resolve a
			// blank id to the bounds of every span in the org that lacks the key.
			hasSessionId($.SpanAttributes, $.SpanAttributes.get(SESSION_ID_ATTR)),
			$.SpanAttributes.get(SESSION_ID_ATTR).eq(param.string("sessionId")),
		])
		.format("JSON")
}

/**
 * The same bounds for a `trace:` session — one whose id names a trace outright,
 * because the vendor exposed no session key (`MAPLE_AI_TRACE_SESSION_PREFIX`).
 *
 * No attribute predicate at all: the id IS the trace id, so `idx_trace_id` on
 * `traces` prunes what `mapValues(SpanAttributes)` prunes for a vendor session,
 * and no presence guard is needed because a trace id cannot be read off a
 * missing Map key. The caller extracts and validates the trace id before it
 * reaches this param — a forged one must never arrive here as a bare string.
 *
 * Padded and `spanCount`-terminated exactly like {@link aiSessionWindowQuery};
 * the two are interchangeable to a caller holding only an id.
 */
export function aiTraceWindowQuery() {
	return from(Traces)
		.select(($) => ({
			startTime: CH.toString_(CH.intervalSub(CH.min_($.Timestamp), FAN_OUT_PAD_SECONDS)),
			endTime: CH.toString_(CH.intervalAdd(CH.max_($.Timestamp), FAN_OUT_PAD_SECONDS)),
			spanCount: CH.count(),
		}))
		.where(($) => [$.OrgId.eq(param.string("orgId")), $.TraceId.eq(param.string("traceId"))])
		.format("JSON")
}

export interface AiSessionSpansOpts {
	readonly limit?: number
}

export interface AiSessionSpansOutput {
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

export const aiSessionSpansRowSchema: CompiledQueryRowSchema<AiSessionSpansOutput> = Schema.Struct({
	traceId: Schema.String,
	spanId: Schema.String,
	parentSpanId: Schema.String,
	spanName: Schema.String,
	spanKind: Schema.String,
	serviceName: Schema.String,
	durationMs: CHNumber,
	statusCode: Schema.String,
	statusMessage: Schema.String,
	timestamp: Schema.String,
	// A Map column selected directly arrives as a JSON object under FORMAT JSON,
	// so this is a plain Record. Not `Schema.fromJsonString(…)` — that is for the
	// observability path, which reads maps already serialized to a string.
	spanAttributes: Schema.Record(Schema.String, Schema.String),
	resourceAttributes: Schema.Record(Schema.String, Schema.String),
})

/** Shared by both span reads, so a session keyed by id and one keyed by trace
 *  cannot drift apart in shape — {@link aiSessionSpansRowSchema} decodes both. */
const spanProjection = ($: ColumnAccessor<typeof TraceDetailSpans.columns>) => ({
	traceId: $.TraceId,
	spanId: $.SpanId,
	parentSpanId: $.ParentSpanId,
	spanName: $.SpanName,
	spanKind: $.SpanKind,
	serviceName: $.ServiceName,
	durationMs: $.Duration.div(1_000_000),
	statusCode: $.StatusCode,
	statusMessage: $.StatusMessage,
	timestamp: CH.toString_($.Timestamp),
	spanAttributes: $.SpanAttributes,
	resourceAttributes: $.ResourceAttributes,
})

/**
 * Every span of every trace belonging to one session, oldest first.
 *
 * `sessionId` is a compile param rather than an opts field, so one compiled SQL
 * string serves every session.
 *
 * Both attribute Maps come back whole: the integration layer that normalizes
 * these into gen_ai form needs keys this query cannot know in advance. Projecting
 * only the keys it wants is a later optimisation, and a real one — one production
 * trace already carries 250 spans with up to ~17KB of attributes each, so callers
 * should expect megabyte-scale payloads at the default limit.
 *
 * No scope columns: `trace_detail_spans` does not carry `ScopeName`/`ScopeVersion`,
 * and the read path does not need them. The ingest gateway already did the
 * scope-based vendor detection at write time and encoded its verdict in
 * `maple_ai.vendor.id`; re-deriving the dialect here would only second-guess it.
 *
 * The window bounds BOTH levels and is required, because the fan-out without one
 * reads every partition the table retains — see this file's header for what that
 * was measured to cost. A session whose traces straddle the window edge returns
 * only the spans inside it, so the bounds a caller passes have to contain the
 * whole session: the list row's `startTime`/`endTime` do by construction, and a
 * caller holding only a session id gets bounds that do from
 * `aiSessionWindowQuery`.
 *
 * Truncation drops the END of the session, because the rows come back oldest
 * first and an agent's answer is the last thing it writes. Ask for
 * `AI_SESSION_SPANS_MAX_SPANS + 1`, slice back to the cap and report the
 * overflow — the idiom `telemetry.http.ts` already uses — rather than showing a
 * truncated transcript as a completed one. Callers should also bound the
 * response by bytes (`compiledQueryBounded`, as the session-replay route does):
 * at the default cap this can return tens of megabytes, and Tinybird rejects the
 * server-side `max_result_bytes` settings that would otherwise cap it.
 */
export function aiSessionSpansQuery(opts: AiSessionSpansOpts = {}) {
	const limit = opts.limit ?? AI_SESSION_SPANS_MAX_SPANS

	const sessionTraceIds = from(Traces)
		.select(($) => ({ TraceId: $.TraceId }))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
			// The presence guard is what stops an empty `sessionId` param from
			// matching every span that simply LACKS the key — ClickHouse reads a
			// missing Map key back as `''`, so equality alone would turn a blank
			// session id into a whole-org trace dump.
			hasSessionId($.SpanAttributes, $.SpanAttributes.get(SESSION_ID_ATTR)),
			$.SpanAttributes.get(SESSION_ID_ATTR).eq(param.string("sessionId")),
		])

	return (
		from(TraceDetailSpans)
			.select(spanProjection)
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				$.Timestamp.gte(param.dateTimeString("startTime")),
				$.Timestamp.lte(param.dateTimeString("endTime")),
				inSubquery($.TraceId, sessionTraceIds),
			])
			// `spanId` breaks ties: agent spans routinely share a millisecond, and
			// without it the LIMIT cuts an arbitrary subset, so two loads of the same
			// truncated session can disagree and a parent can survive while its
			// children are dropped.
			.orderBy(["timestamp", "asc"], ["spanId", "asc"])
			.limit(limit)
			.format("JSON")
	)
}

/**
 * Every span of ONE trace, oldest first — the spans of a `trace:` session.
 *
 * {@link aiSessionSpansQuery} without its detection half: the id already names
 * the trace, so there is nothing to resolve and `TraceId` is a sort-key prefix
 * of `trace_detail_spans`. Everything else is identical, deliberately — same
 * projection, same row schema, same tie-broken order, same truncation contract —
 * so the detail page reads one shape whichever kind of session it opened.
 *
 * The window is still required and still bounds the read: `TraceId` prunes the
 * sort key, the `Timestamp` predicate prunes partitions, and only both together
 * keep this off every partition the table retains.
 */
export function aiTraceSpansQuery(opts: AiSessionSpansOpts = {}) {
	const limit = opts.limit ?? AI_SESSION_SPANS_MAX_SPANS

	return from(TraceDetailSpans)
		.select(spanProjection)
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString("startTime")),
			$.Timestamp.lte(param.dateTimeString("endTime")),
			$.TraceId.eq(param.string("traceId")),
		])
		.orderBy(["timestamp", "asc"], ["spanId", "asc"])
		.limit(limit)
		.format("JSON")
}
