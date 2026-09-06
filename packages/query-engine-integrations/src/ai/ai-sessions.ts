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
// The list is that fan-out, in two stages against two different tables — and
// two round trips, because the second is bounded by what the first found:
//
//   page — `aiSessionPageQuery`, over `ai_trace_index`: the filtered
//     projection holding ONLY the vendor-stamped spans (~0.01% of rows),
//     pre-extracted to plain columns by `ai_trace_index_mv`. It is the one
//     level that sees the caller's whole window, and the one that can afford
//     to: ~10k narrow rows a day against 70M raw spans, ~600ms cold over 30
//     days of production. It resolves every trace to its session key, ranks
//     the sessions by their first agent span, and yields one page of session
//     ids with the bounds of their agent spans — nothing else.
//   fan out — `aiSessionListQuery`, over `trace_detail_spans`, restricted to
//     that page's traces by `TraceId IN (…)`. `TraceId` is a sort-key prefix
//     there (`(OrgId, TraceId, SpanId)`), so this is a seek. The same fan-out
//     against raw `traces` times out at 10s on a 7-day window in production:
//     that table is sorted `(OrgId, ServiceName, SpanName, Timestamp)` and
//     `idx_trace_id` is only a bloom skip index, which prunes far too little
//     at this org's volume.
//
// Detection used to run the vendor predicate against raw `traces` behind the
// `mapKeys(SpanAttributes)` bloom skip index, and that shape cannot be saved:
// GenAI spans arrive continuously — about one per index granule at production
// volume — so the bloom prunes nothing and the scan reads the fat Map column
// for EVERY span in the window. Measured 2026-08-29 in production: ~3.6s for a
// one-hour window, dead at the 15s kill by a day. The index is the same
// predicate applied at insert time.
//
// The fan-out used to run over every qualifying trace in the window and page
// with LIMIT/OFFSET afterwards, and that shape cannot be saved either — by the
// index or by anything else. `trace_detail_spans` sits on object storage, and
// what a seek costs there is set by the partitions it touches, not by the rows
// it returns: measured 2026-09-02 in production, five trace ids across the 32
// retained partitions ran past 10s, while a page's worth of sessions inside
// one partition took 1.3–2.8s cold and ~300ms warm. The old shape read three
// partitions for a one-day window (5–15s, eight of 31 reads killed at the 15s
// ceiling over three days) and all of them for the 30-day window the page
// offers (killed, every time). Paging first is what bounds the fan-out to the
// hours a page spans.
//
// `IN` rather than a JOIN for the fan-out, the same reason
// `errorDetailTracesQuery` uses it — ClickHouse pushes the id set into the
// read, which a JOIN does not do. The JOIN the list DOES carry is one level up,
// between two derived tables of at most a page of traces each, and it is there
// so the fan-out takes the session key the page resolved rather than deriving
// its own from the spans: two derivations over two windows can disagree, and
// a disagreement would drop the row from the page it was ranked into.
//
// The index fills forward from its deploy: rows already in `traces` when the MV
// was created are not in it until a backfill runs, so the page (and the
// facets) can under-report windows that predate the deploy. The fan-out and the
// per-session reads still see every span of any trace the page finds.
//
// The window predicate on the fan-out is the PAGE's, not the caller's: the
// bounds of the page's agent spans, padded by `FAN_OUT_PAD_SECONDS` so a
// trace's non-agent spans on either side are counted too. `trace_detail_spans`
// is `PARTITION BY toDate(Timestamp)`, so the predicate is the only thing that
// prunes partitions there. What that buys depends on how densely an org runs
// agents: at production volume a page of sessions ordered by start spans
// hours — one partition, two around midnight — while an org with a few
// sessions a day has a first page that spans weeks, and its fan-out probes
// every partition in between exactly as the old shape did (no worse, no
// better; a chunked or per-partition fan-out is the follow-up if that bites).
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
import * as T from "@maple-dev/clickhouse-builder/types"
import {
	compileFnCall,
	from,
	fromQuery,
	inSubquery,
	param,
	QueryBuilderDefect,
	unionAll,
	type CHUnionQuery,
	type ColumnAccessor,
	type CompiledQueryRowSchema,
} from "@maple-dev/clickhouse-builder"
import { AiTraceIndex, TraceDetailSpans, Traces } from "@maple/query-engine/ch/tables"
import { CHNumber } from "@maple/query-engine/ch/schema"
import { AI_SESSION_SPANS_MAX_SPANS, type AiSessionSortDir, type AiSessionSortKey } from "@maple/domain/http"
import {
	MAPLE_AI_SESSION_ID_ATTR,
	MAPLE_AI_TRACE_SESSION_PREFIX,
	MAPLE_AI_VENDOR_ID_ATTR,
	MAPLE_AI_VENDOR_VERSION_ATTR,
} from "@maple/domain/gen-ai"
import { sessionLlmCalls, sessionUsageSum, usageReportersExpr } from "./ai-span-columns"

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
 * How far past the page's own agent-span bounds the `trace_detail_spans`
 * fan-out reads, in seconds — see `aiSessionListQuery`.
 *
 * The pad exists because a trace's non-agent spans lie outside its agent
 * spans: measured over two days of production (4,920 agent traces,
 * 2026-09-02), the first span leads the first agent span by at most 0.1s and
 * the last span trails the last agent span by at most 10 minutes. An hour
 * contains both with room to spare and keeps the read inside one partition
 * (`PARTITION BY toDate(Timestamp)`) for every page but the ones nearest
 * midnight; a day would make it three partitions every time, which is what
 * the fan-out's cost is made of. A trace whose spans reach further than an
 * hour past its agent spans is clamped in the list row alone.
 */
const FAN_OUT_PAD_SECONDS = 3_600

/**
 * The pad on the bounds `aiSessionWindowQuery`/`aiTraceWindowQuery` report for
 * a deep link, in seconds. A whole partition rather than the list's hour: that
 * path resolves ONE session, so the extra partitions cost one read, and the
 * detail page shows the spans themselves — clamping there would cut a
 * transcript, where the list would only under-count a cell.
 */
const WINDOW_PAD_SECONDS = 86_400

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

/**
 * The filters the page and the list share; both apply them on `ai_trace_index`,
 * each as a per-trace existence test — see `indexTraces`. One per index
 * column, so each selects exactly the population `aiSessionFacetsQuery`
 * counted for it.
 */
export interface AiSessionFilterOpts {
	readonly vendorIds?: readonly string[]
	readonly serviceNames?: readonly string[]
	readonly deploymentEnvs?: readonly string[]
	readonly models?: readonly string[]
	readonly agentNames?: readonly string[]
	readonly toolNames?: readonly string[]
	/**
	 * A session id or trace id, or the leading characters of one — what a
	 * reader pastes from a ticket, a log line, or the list row itself. Matched
	 * as a prefix against both id columns of the index.
	 */
	readonly search?: string
}

export interface AiSessionPageOpts extends AiSessionFilterOpts {
	/** Sessions returned, most recently started first unless `sortBy` says otherwise. */
	readonly limit?: number
	/** Sessions skipped before `limit` applies — the list's next page. */
	readonly offset?: number
	// Session-level filters — `HAVING` on the ranked session row, over the
	// measures the index carries per span (migration 0026). A failure here is
	// a failed AGENT span; the row's `errorSpanCount` counts every span of the
	// trace, so a session whose only error is on an HTTP span is listed with a
	// badge and not matched by the filter. A duration here is the extent of
	// the agent spans, which the true extent trails by minutes at most (see
	// `FAN_OUT_PAD_SECONDS`).
	readonly hasErrors?: boolean
	/** Drop the `trace:` sessions — traces whose vendor exposes no session key. */
	readonly excludeTraceSessions?: boolean
	readonly durationMinMs?: number
	readonly durationMaxMs?: number
	readonly costMin?: number
	readonly costMax?: number
	readonly tokensMin?: number
	readonly tokensMax?: number
	readonly llmCallsMin?: number
	readonly llmCallsMax?: number
	readonly toolCallsMin?: number
	readonly toolCallsMax?: number
	readonly sortBy?: AiSessionSortKey
	readonly sortDir?: AiSessionSortDir
}

export interface AiSessionPageOutput {
	/** The vendor's own session id, or `trace:<TraceId>` for a trace that has
	 *  none — see `MAPLE_AI_TRACE_SESSION_PREFIX`. */
	readonly sessionId: string
	/** Bounds of the session's agent spans inside the window — warehouse
	 *  datetime literals, the shape `aiSessionListQuery`'s `fanOutStart` and
	 *  `fanOutEnd` params take back. */
	readonly agentStart: string
	readonly agentEnd: string
	/** Every model any agent span of the session ran on, dialects coalesced. */
	readonly models: readonly string[]
	/** Every agent named on any agent span of the session. */
	readonly agentNames: readonly string[]
	readonly llmCalls: number
	readonly toolCalls: number
	/** Failed agent spans — what `hasErrors` tests; not the row's all-span count. */
	readonly errorAgentSpans: number
	/** Tokens across every bucket, deepest reporter counted — see `deepestReporterSum`. */
	readonly totalTokens: number
	/** USD as the instrumentation priced it; 0 where nothing reported a cost. */
	readonly cost: number
	/** Extent of the agent spans, what the duration filter and sort read. */
	readonly agentDurationMs: number
}

export interface AiSessionListOpts extends AiSessionFilterOpts {
	/**
	 * The page to aggregate, as `aiSessionPageQuery` ranked it — under the same
	 * filters, or the two stages resolve traces differently. Never empty: an
	 * empty page is answered without this read, and an empty list here is a
	 * defect rather than an empty result.
	 */
	readonly sessionIds: readonly string[]
}

/** Which pair of params bounds an `ai_trace_index` read: the caller's window
 *  (`startTime`/`endTime`) or the page's (`fanOutStart`/`fanOutEnd`). */
type IndexBounds = "window" | "page"

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
 * A pasted id, as a `LIKE` prefix pattern.
 *
 * Strips what the list row itself shows around a `trace:` id — the prefix and
 * the trailing ellipsis — so copying the visible text finds the row. Escapes the
 * three characters `LIKE` reads as syntax; the builder quotes the literal.
 */
export function idSearchPattern(search: string): string {
	let needle = search.trim()
	if (needle.startsWith(MAPLE_AI_TRACE_SESSION_PREFIX)) {
		needle = needle.slice(MAPLE_AI_TRACE_SESSION_PREFIX.length)
	}
	needle = needle.replace(/…+$/, "")
	return `${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

/** Distinct models/agents collected per trace for the list row. */
const MAX_NAMES_PER_TRACE = 20

/**
 * One row per agent trace in the window, off `ai_trace_index` alone: the
 * trace's session key, the bounds of its agent spans, and the per-trace
 * measures the page ranks on. The level both stages share, so a trace resolves
 * to the same session in the page and in the aggregation.
 *
 * The page reads it over the caller's window; the aggregation over the page's
 * own bounds, which is the same thing for every trace ON the page: a page
 * trace's index rows all lie between its session's `agentStart` and `agentEnd`,
 * and the page's bounds contain every session's. So the key and the filters
 * come out identical, from hours of the index rather than the caller's month.
 * A trace that is NOT on the page can key differently over the narrower read,
 * and is then discarded by the page's key list like any other — unless it
 * carries two session ids and only the lesser one falls inside the page's
 * bounds, which no vendor has been seen to produce.
 *
 * `rawSessionId` is `max` over the trace's index rows because the session id
 * sits on the turn-owning span alone (see the file header) and every other row
 * reads `''`, which `max` discards.
 *
 * A filter is a TRACE-level existence test — "some agent span of the trace
 * carries this value" — applied after the grouping, not a row predicate before
 * it. A row predicate would also narrow the rows `rawSessionId` is read from,
 * and a vendor filter would then file a trace under `trace:` whenever its
 * session-bearing span belongs to another vendor — an eve agent calling through
 * the Vercel AI SDK carries both. And the three GenAI identity columns are
 * mutually exclusive by construction — a chat span has a model and no tool, a
 * tool span the reverse, the session id sits on the turn-owning span alone —
 * so a row predicate ANDing `Model IN (…)` with `ToolName IN (…)` could only
 * match a row carrying both, and that pair of facets, each with a non-zero
 * count, would return an empty list. The population is the one the facets
 * count: `aiSessionFacetsQuery` also collects per trace and counts any-span.
 *
 * The measures are collected here per trace and summed per session one level
 * up. Usage travels as the trace's reporters rather than a sum, because a
 * wrapper's roll-up of its children cannot be undone one row at a time — see
 * `usageReportersExpr`.
 */
const indexTraces = (opts: AiSessionFilterOpts, bounds: IndexBounds) => {
	const values = (list: readonly string[] | undefined) => (list?.length ? list : undefined)
	const search = opts.search?.trim() || undefined
	const carries = (cond: CH.Condition) => CH.countIf(cond).gt(0)
	return from(AiTraceIndex)
		.select(($) => ({
			traceId: $.TraceId,
			rawSessionId: CH.max_($.SessionId),
			// Named apart from the page's `agentStart`/`agentEnd`: an outer alias
			// shadows the derived table's column of the same name, so `min(…)` of
			// it would resolve to the outer `toString(…)` String and fail — see
			// `traceStart` in `aiSessionListQuery`.
			traceAgentStart: CH.min_($.Timestamp),
			traceAgentEnd: CH.max_($.Timestamp),
			// `Timestamp` is the span's START; the extent ends where the
			// last-starting agent span ended. Same idiom as `traceEndNanos`.
			traceAgentEndNanos: CH.max_(CH.toUnixTimestamp64Nano($.Timestamp).add(CH.toInt64($.Duration))),
			// Bounded per trace: a row is a list cell, and a trace that somehow
			// names more models than that is not one the cell can show anyway.
			models: CH.groupUniqArrayIf(MAX_NAMES_PER_TRACE)($.Model, $.Model.neq("")),
			agentNames: CH.groupUniqArrayIf(MAX_NAMES_PER_TRACE)($.AgentName, $.AgentName.neq("")),
			toolCalls: CH.sum($.IsToolCall),
			errorAgentSpans: CH.sum($.IsError),
			// Usage AND model calls travel as reporters: both are counted one level
			// up, where every trace of the session is in hand — see `ai-span-columns`.
			usageReporters: usageReportersExpr($),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTimeString(bounds === "window" ? "startTime" : "fanOutStart")),
			$.Timestamp.lte(param.dateTimeString(bounds === "window" ? "endTime" : "fanOutEnd")),
		])
		.groupBy("traceId")
		.having(($) => [
			CH.when(values(opts.vendorIds), (v) => carries(CH.inList($.VendorId, v))),
			CH.when(values(opts.serviceNames), (v) => carries(CH.inList($.ServiceName, v))),
			CH.when(values(opts.deploymentEnvs), (v) => carries(CH.inList($.DeploymentEnv, v))),
			CH.when(values(opts.models), (v) => carries(CH.inList($.Model, v))),
			CH.when(values(opts.agentNames), (v) => carries(CH.inList($.AgentName, v))),
			CH.when(values(opts.toolNames), (v) => carries(CH.inList($.ToolName, v))),
			CH.when(search, (needle) => {
				const pattern = idSearchPattern(needle)
				return carries($.SessionId.like(pattern).or($.TraceId.like(pattern)))
			}),
		])
}

/**
 * The page: which sessions the list shows, in what order, and where their
 * agent spans lie — the first of the list's two reads, and the only one that
 * sees the caller's whole window. See the file header for why the fan-out
 * cannot.
 *
 * Detection admits any trace with a GenAI span, and the session id then groups
 * rather than admits: a trace that carries one is filed under it — with the
 * session's other traces — and a trace that carries none becomes a session of
 * its own, keyed `trace:<TraceId>`. Sessionless is the normal state for whole
 * vendors, not an edge case; see this file's header.
 *
 * Ordered by the first AGENT span, not the first span of any kind: the index
 * carries only agent spans, and the two differ by under a second in practice
 * (see `FAN_OUT_PAD_SECONDS`). The row's `startTime` still reports the true
 * first span; the caller keeps the page in this order rather than re-sorting
 * by it, so what is shown is the order that was paged. A measure sort
 * (`sortBy`) orders by that measure first, with the first agent span and then
 * `sessionId` breaking ties, so a page boundary never splits two sessions that
 * share a start.
 *
 * The session-level filters are `HAVING` on the ranked row, over the measures
 * the index carries per span, and cost nothing beyond the index scan the page
 * already is. What they cannot do is count — a facet for "sessions over $1"
 * would be another pass over the same index per bucket, which the sidebar
 * does not ask for.
 *
 * The remaining gap is between traces, not inside one: a session whose OTHER
 * traces lie entirely outside the range is still found only by the traces that
 * touched it, which needs a session-keyed table to fix and not a wider window.
 */
export function aiSessionPageQuery(opts: AiSessionPageOpts = {}) {
	const limit = opts.limit ?? 50
	const offset = opts.offset ?? 0

	// The `HAVING` level sees the outer aliases by name only.
	const having = {
		sessionId: CH.dynamicColumn<string>("sessionId", T.string),
		errorAgentSpans: CH.dynamicColumn<number>("errorAgentSpans", T.float64),
		agentDurationMs: CH.dynamicColumn<number>("agentDurationMs", T.float64),
		cost: CH.dynamicColumn<number>("cost", T.float64),
		totalTokens: CH.dynamicColumn<number>("totalTokens", T.float64),
		llmCalls: CH.dynamicColumn<number>("llmCalls", T.float64),
		toolCalls: CH.dynamicColumn<number>("toolCalls", T.float64),
	}
	const sortBy = opts.sortBy ?? "startTime"
	const sortDir = opts.sortDir ?? "desc"
	// The measure a sort key names on this level. `startTime` is the first
	// agent span, and `errorSpanCount` the failed agent spans — the row's own
	// numbers are the fan-out's, which the page cannot see.
	const sortColumn = {
		startTime: "agentStart",
		durationMs: "agentDurationMs",
		cost: "cost",
		totalTokens: "totalTokens",
		errorSpanCount: "errorAgentSpans",
		llmCalls: "llmCalls",
		toolCalls: "toolCalls",
	} as const satisfies Record<AiSessionSortKey, string>
	const order: Array<[(typeof sortColumn)[AiSessionSortKey] | "sessionId", AiSessionSortDir]> =
		sortBy === "startTime"
			? [["agentStart", sortDir]]
			: [
					[sortColumn[sortBy], sortDir],
					["agentStart", "desc"],
				]
	order.push(["sessionId", "asc"])

	const page = fromQuery(indexTraces(opts, "window"), "index_traces")
		.select(($) => ({
			// The grouping key, and the only level that can compute it: the
			// derived table is one row per trace, so a trace with no session id
			// of its own becomes a session of one trace here rather than joining
			// every other sessionless trace under `''`.
			sessionId: sessionKey($.rawSessionId, $.traceId),
			agentStart: CH.toString_(CH.min_($.traceAgentStart)),
			agentEnd: CH.toString_(CH.max_($.traceAgentEnd)),
			models: CH.groupUniqArrayArray($.models),
			agentNames: CH.groupUniqArrayArray($.agentNames),
			llmCalls: sessionLlmCalls("usageReporters"),
			toolCalls: CH.sum($.toolCalls),
			errorAgentSpans: CH.sum($.errorAgentSpans),
			totalTokens: sessionUsageSum("usageReporters", 3),
			cost: sessionUsageSum("usageReporters", 4),
			// Nanoseconds first, wrapped in `intDiv` — see `durationMs` in
			// `aiSessionListQuery` for both.
			agentDurationMs: CH.intDiv(
				CH.max_($.traceAgentEndNanos).sub(CH.toUnixTimestamp64Nano(CH.min_($.traceAgentStart))),
				1_000_000,
			),
		}))
		.groupBy("sessionId")
		.having(() => [
			CH.whenTrue(opts.hasErrors, () => having.errorAgentSpans.gt(0)),
			CH.whenTrue(opts.excludeTraceSessions, () =>
				CH.not(having.sessionId.like(`${MAPLE_AI_TRACE_SESSION_PREFIX}%`)),
			),
			CH.when(opts.durationMinMs, (v) => having.agentDurationMs.gte(v)),
			CH.when(opts.durationMaxMs, (v) => having.agentDurationMs.lte(v)),
			CH.when(opts.costMin, (v) => having.cost.gte(v)),
			CH.when(opts.costMax, (v) => having.cost.lte(v)),
			CH.when(opts.tokensMin, (v) => having.totalTokens.gte(v)),
			CH.when(opts.tokensMax, (v) => having.totalTokens.lte(v)),
			CH.when(opts.llmCallsMin, (v) => having.llmCalls.gte(v)),
			CH.when(opts.llmCallsMax, (v) => having.llmCalls.lte(v)),
			CH.when(opts.toolCallsMin, (v) => having.toolCalls.gte(v)),
			CH.when(opts.toolCallsMax, (v) => having.toolCalls.lte(v)),
		])
		// A String order, and a correct one: the literal is fixed-width
		// `YYYY-MM-DD hh:mm:ss.nnnnnnnnn`, so it sorts as the instant does.
		.orderBy(...order)
		.limit(limit)
	// Only a positive offset is emitted: `OFFSET 0` is a no-op that would still
	// change the compiled SQL of every first-page read.
	return (offset > 0 ? page.offset(offset) : page).format("JSON")
}

/**
 * One row per session of the page `aiSessionPageQuery` ranked, with every
 * fact the list shows that the index cannot answer — the second of the list's
 * two reads. Bounded by the page alone: `fanOutStart`/`fanOutEnd` are the
 * extent of the page's agent spans, and both the index reads and the fan-out
 * run inside them (padded, for the fan-out) — see `indexTraces` for why the
 * index level resolves a page trace exactly as the page did without the
 * caller's window.
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
 * The filters land on the index level, which means "the trace's agent spans
 * came from this service" rather than "the trace touched this service". A
 * trace spans services by definition, so the alternative — filtering the
 * fan-out — would silently drop spans and under-count `spanCount`. The agent
 * spans come from the agent's own service, which is the one a user filtering by
 * service means.
 *
 * Once a trace is on the page it is aggregated across the padded fan-out window
 * rather than the caller's, so `startTime`/`endTime`/`durationMs`/`spanCount`/
 * `errorSpanCount`/`serviceNames` describe the whole trace rather than the
 * slice of it that fell inside the range — a session that began an hour before
 * the range no longer reports the range edge as its start, and the detail page
 * can read the bounds this row carries as the session's own.
 *
 * Ordered by `startTime` for a caller that reads it alone; the list's caller
 * re-imposes the page's order, which this row cannot know.
 */
export function aiSessionListQuery(opts: AiSessionListOpts) {
	// A defect, not a failure: `IN ()` is not SQL, and the caller already knows
	// its page is empty — see `AiSessionListOpts`.
	if (opts.sessionIds.length === 0) {
		throw new QueryBuilderDefect({
			message: "aiSessionListQuery needs the page's session ids; an empty page is answered without it",
		})
	}
	// The page's traces, keyed as the page keyed them — read twice below, once
	// as the id set the fan-out seeks by and once joined for the key, over the
	// page's bounds rather than the caller's window (see `indexTraces`).
	const onPage = ($: { rawSessionId: CH.Expr<string>; traceId: CH.Expr<string> }) =>
		CH.inList(sessionKey($.rawSessionId, $.traceId), opts.sessionIds)
	const pageTraceIds = fromQuery(indexTraces(opts, "page"), "agent_traces")
		.select(($) => ({ traceId: $.traceId }))
		.where(($) => [onPage($)])
	const pageTraces = fromQuery(indexTraces(opts, "page"), "agent_traces")
		.select(($) => ({ traceId: $.traceId, rawSessionId: $.rawSessionId }))
		.where(($) => [onPage($)])

	// Per trace: every span of a page trace, session-bearing or not, inside the
	// page's padded window.
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
			$.Timestamp.gte(CH.intervalSub(param.dateTimeString("fanOutStart"), FAN_OUT_PAD_SECONDS)),
			$.Timestamp.lte(CH.intervalAdd(param.dateTimeString("fanOutEnd"), FAN_OUT_PAD_SECONDS)),
			inSubquery($.TraceId, pageTraceIds),
		])
		.groupBy("traceId")

	return fromQuery(perTrace, "session_traces")
		.innerJoinQuery(pageTraces, "index_traces", (t, i) => t.traceId.eq(i.traceId))
		.select(($) => ({
			// The key the page resolved, not one re-derived from the spans — see
			// the file header for why the two must not be allowed to differ.
			sessionId: sessionKey($.index_traces.rawSessionId, $.traceId),
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
		.groupBy("sessionId")
		.orderBy(["startTime", "desc"])
		.format("JSON")
}

// List facets (UNION ALL — one branch per index dimension)

export interface AiSessionFacetsOutput {
	readonly name: string
	readonly count: number
	readonly facetType: string
}

export type AiSessionFacetType = "vendor" | "service" | "environment" | "model" | "agent" | "tool"

/**
 * Distinct sessions per value of each index dimension, for the list's filter
 * sidebar: vendor, service, environment, model, agent and tool.
 *
 * This is the page's index scan (`indexTraces`) and nothing else — no
 * `trace_detail_spans` fan-out, which is the expensive half. It can be: every
 * one of the list's counted filters is applied at that level, so the population
 * a facet describes is exactly the population its filter selects. The
 * session-level filters (errors, the ranges) have no facet for the same reason
 * in reverse — their numbers exist only per ranked row.
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
		facetType: AiSessionFacetType,
		name: ($: ColumnAccessor<typeof AiTraceIndex.columns>) => CH.Expr<string>,
	) => {
		const perTrace = from(AiTraceIndex)
			.select(($) => ({
				traceId: $.TraceId,
				// Over EVERY span of the trace, not only those carrying the value:
				// the session id sits on the turn-owning span and the model on the
				// chat span beneath it, so keying the trace off the value-bearing
				// rows alone would file it as a sessionless trace of its own — and
				// count a session once per trace that names the value. A blank
				// option filters nothing and is not offered, hence the `If`; a trace
				// naming nothing yields no row from the `arrayJoin` below.
				rawSessionId: CH.max_($.SessionId),
				names: CH.groupUniqArrayIf(MAX_NAMES_PER_TRACE)(name($), name($).neq("")),
			}))
			.where(($) => [
				// Every UNION ALL branch reads a table, so every branch carries the org
				// predicate itself — see this file's header.
				$.OrgId.eq(param.string("orgId")),
				$.Timestamp.gte(param.dateTimeString("startTime")),
				$.Timestamp.lte(param.dateTimeString("endTime")),
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
		facet("environment", ($) => $.DeploymentEnv),
		facet("model", ($) => $.Model),
		facet("agent", ($) => $.AgentName),
		facet("tool", ($) => $.ToolName),
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
 * The bounds come back padded by `WINDOW_PAD_SECONDS`, because they are
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
			startTime: CH.toString_(CH.intervalSub(CH.min_($.Timestamp), WINDOW_PAD_SECONDS)),
			endTime: CH.toString_(CH.intervalAdd(CH.max_($.Timestamp), WINDOW_PAD_SECONDS)),
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
			startTime: CH.toString_(CH.intervalSub(CH.min_($.Timestamp), WINDOW_PAD_SECONDS)),
			endTime: CH.toString_(CH.intervalAdd(CH.max_($.Timestamp), WINDOW_PAD_SECONDS)),
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
