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
// Both queries are that fan-out, in two stages against two different tables:
//
//   detect  — `traces`, filtered on the presence of `maple_ai.session.id`. This
//     is the only level that can use the `mapKeys(SpanAttributes)` bloom skip
//     index, and with it the scan stays cheap over a week. It yields the
//     qualifying trace-id set and nothing else.
//   fan out — `trace_detail_spans`, restricted by `TraceId IN (…)`. `TraceId` is
//     a sort-key prefix there (`(OrgId, TraceId, SpanId)`), so this is a seek.
//     The same fan-out against raw `traces` times out at 10s on a 7-day window
//     in production: that table is sorted `(OrgId, ServiceName, SpanName,
//     Timestamp)` and `idx_trace_id` is only a bloom skip index, which prunes
//     far too little at this org's volume.
//
// That is the "optimise the query, not the storage" answer to the fan-out: no
// new table, no new index, an MV that already exists and that
// `errorDetailTracesQuery` already splits across for exactly this reason. `IN`
// rather than a JOIN for the same reason too — ClickHouse pushes the id set into
// the read, which a JOIN does not do.
//
// The window predicate stays on BOTH levels. On `trace_detail_spans` it prunes
// partitions (`PARTITION BY toDate(Timestamp)`) as well as riding the sort key,
// so it is strictly cheaper than omitting it.
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
	type CompiledQueryRowSchema,
} from "@maple-dev/clickhouse-builder"
import { TraceDetailSpans, Traces } from "@maple/query-engine/ch/tables"
import { CHNumber } from "@maple/query-engine/ch/schema"

const SESSION_ID_ATTR = "maple_ai.session.id"
const VENDOR_ID_ATTR = "maple_ai.vendor.id"
const VENDOR_VERSION_ATTR = "maple_ai.vendor.version"

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
 * Default span cap for `aiSessionSpansQuery`, exported so a caller can request
 * `+ 1` and detect truncation instead of hardcoding the number. Mirrors
 * `SPAN_HIERARCHY_MAX_SPANS`, which is exported from the core package for the
 * same reason.
 */
export const AI_SESSION_SPANS_MAX_SPANS = 2_000

/** ClickHouse returns `''` for a missing Map key, so presence needs both halves. */
const hasSessionId = (attrs: CH.Expr<Record<string, string>>, get: CH.Expr<string>) =>
	CH.mapContains(attrs, SESSION_ID_ATTR).and(get.neq(""))

/** Not in the builder's function set; same local helper `tracesDetailQuery` uses. */
const fromUnixTimestamp64Nano = (nanos: CH.Expr<number>): CH.Expr<string> =>
	compileFnCall<string>("fromUnixTimestamp64Nano", nanos)

export interface AiSessionListOpts {
	/** Sessions returned, most recently started first. */
	readonly limit?: number
	readonly vendorIds?: readonly string[]
	readonly serviceNames?: readonly string[]
}

export interface AiSessionListOutput {
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

export const aiSessionListRowSchema: CompiledQueryRowSchema<AiSessionListOutput> = Schema.Struct({
	sessionId: Schema.String,
	vendorId: Schema.String,
	vendorVersion: Schema.String,
	traceCount: CHNumber,
	spanCount: CHNumber,
	errorSpanCount: CHNumber,
	serviceNames: Schema.Array(Schema.String),
	startTime: Schema.String,
	endTime: Schema.String,
	durationMs: CHNumber,
})

/**
 * One row per AI agent session in the window.
 *
 * `vendorId` is the vendor of the EARLIEST span that carries a session id, not
 * `max(vendorId)`. A single trace legitimately carries several vendors — an eve
 * agent calls through the Vercel AI SDK — and `max` picked `vercel_ai_sdk`
 * alphabetically over `eve` when `eve` was the framework actually running the
 * turn. The root-most session-bearing span is the one that names the framework,
 * so the two `argMin`s (per trace, then across traces) resolve to it.
 *
 * The vendor filter goes on the detection subquery: it is the level the bloom
 * index serves, and it is the only place `maple_ai.vendor.id` is unambiguous —
 * a trace's other spans carry other vendors, or none.
 *
 * The service filter goes there too, which means "the session-bearing spans came
 * from this service" rather than "the trace touched this service". A trace spans
 * services by definition, so the alternative — filtering the fan-out — would
 * silently drop spans and under-count `spanCount`. The session-bearing spans come
 * from the agent's own service, which is the one a user filtering by service means.
 */
export function aiSessionListQuery(opts: AiSessionListOpts = {}) {
	const limit = opts.limit ?? 50

	const sessionTraceIds = from(Traces)
		.select(($) => ({ TraceId: $.TraceId }))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			hasSessionId($.SpanAttributes, $.SpanAttributes.get(SESSION_ID_ATTR)),
			opts.vendorIds?.length
				? CH.inList($.SpanAttributes.get(VENDOR_ID_ATTR), opts.vendorIds)
				: undefined,
			opts.serviceNames?.length ? CH.inList($.ServiceName, opts.serviceNames) : undefined,
		])

	// Per trace: every span of a qualifying trace, session-bearing or not.
	const perTrace = from(TraceDetailSpans)
		.select(($) => {
			const sessionOrder = CH.if_(
				hasSessionId($.SpanAttributes, $.SpanAttributes.get(SESSION_ID_ATTR)),
				$.Timestamp,
				CH.toDateTime(CH.lit(SESSION_ORDER_SENTINEL)),
			)
			return {
				traceId: $.TraceId,
				// A trace belongs to one session; the non-bearing spans read `''`,
				// which `max` discards.
				sessionId: CH.max_($.SpanAttributes.get(SESSION_ID_ATTR)),
				vendorId: CH.argMin($.SpanAttributes.get(VENDOR_ID_ATTR), sessionOrder),
				vendorVersion: CH.argMin($.SpanAttributes.get(VENDOR_VERSION_ATTR), sessionOrder),
				// Carried so the outer level can order traces by their first
				// session-bearing span rather than by their first span of any kind.
				sessionStart: CH.min_(sessionOrder),
				spanCount: CH.count(),
				errorSpanCount: CH.countIf($.StatusCode.eq("Error")),
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
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			inSubquery($.TraceId, sessionTraceIds),
		])
		.groupBy("traceId")

	return (
		fromQuery(perTrace, "session_traces")
			.select(($) => ({
				sessionId: $.sessionId,
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
			// A trace can qualify via the IN and still roll up empty if its only
			// session-bearing span fell outside the window.
			.where(($) => [$.sessionId.neq("")])
			.groupBy("sessionId")
			.orderBy(["startTime", "desc"])
			.limit(limit)
			.format("JSON")
	)
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
 * Known v1 limitation: the time window bounds BOTH levels, so a session whose
 * traces straddle the window edge returns only the spans inside it.
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
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			// The presence guard is what stops an empty `sessionId` param from
			// matching every span that simply LACKS the key — ClickHouse reads a
			// missing Map key back as `''`, so equality alone would turn a blank
			// session id into a whole-org trace dump.
			hasSessionId($.SpanAttributes, $.SpanAttributes.get(SESSION_ID_ATTR)),
			$.SpanAttributes.get(SESSION_ID_ATTR).eq(param.string("sessionId")),
		])

	return (
		from(TraceDetailSpans)
			.select(($) => ({
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
			}))
			.where(($) => [
				$.OrgId.eq(param.string("orgId")),
				$.Timestamp.gte(param.dateTime("startTime")),
				$.Timestamp.lte(param.dateTime("endTime")),
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
