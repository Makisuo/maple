// Typed Agent Sessions Queries
//
// Read path over the AI classification columns the ingest classifier stamps on
// `traces` (AiVendor / AiSessionKeyState / AiSessionKeyHash — migration 0016).
// One filter payload feeds two tabs:
//
//   - sessions: rows whose key resolved at session granularity
//     (`AiSessionKeyState = 6`), grouped by `AiSessionKeyHash`.
//   - traces: every AI-classified row (`AiVendor != ''`) at any key state,
//     grouped by `TraceId`.
//
// Classification is strictly per span, and a single trace routinely mixes
// vendors (a CrewAI orchestration span parenting openinference-instrumented
// OpenAI calls), so `vendors` is an array on every output row and the
// vendor/service filters mean *containment*: "has at least one matching span".
// Containment is a post-aggregation predicate, so those filters live in HAVING
// over the same aggregates the row reports — never in WHERE, which would drop
// the non-matching spans from the row's own counts.
//
// The facet branches read one grouped subquery and `arrayJoin` its arrays, so
// facet counts and list rows share a single grouping by construction (the
// traces list/facets pair maintains that invariant across two hand-written
// extractors, which is how its exclusion filters drifted).
//
// The session key itself is not selectable here: only the hash is a column,
// and the plaintext lives in `SpanAttributes` under a vendor-specific key.
// Resolving it for display is the vendor-integration layer's job on the
// detail read.

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { param } from "@maple-dev/clickhouse-builder"
import { from, fromQuery, type ColumnAccessor } from "@maple-dev/clickhouse-builder"
import { unionAll, type CHUnionQuery } from "@maple-dev/clickhouse-builder"
import { Traces } from "../tables"
import type { FacetOutput } from "./query-helpers"

/** `AiSessionKeyState` value for "key resolved at session granularity" — the
 *  only state whose hash identifies a customer-facing session. Frozen on the
 *  write side (`session_state::SESSION` in `ai_classifier.rs`); the rollup MV
 *  persists comparisons over it, so it can never renumber. */
const SESSION_GRANULARITY = 6

/** "Contains at least one span matching ANY of `values`" over an aggregated
 *  array column. Returns undefined (condition dropped) when no filter is set. */
const containsAny = (
	arr: CH.Expr<ReadonlyArray<string>>,
	values: readonly string[] | undefined,
): CH.Condition | undefined =>
	values && values.length > 0
		? values.map((v) => CH.has(arr, v)).reduce((a, b) => a.or(b))
		: undefined

/** Wall-clock ms from the first span start to the last span END — `Duration`
 *  is nanoseconds, so the last span's own runtime counts. A plain max(start) −
 *  min(start) would report 0 for the common single-span-per-key case.
 *
 *  Each aggregate divides before the subtraction (the DSL's infix operators
 *  don't parenthesize, so `a.sub(b).div(n)` binds as `a - b/n`), and Duration
 *  casts to Int64 because ClickHouse has no UInt64/Int64 supertype to add the
 *  Int64 nanosecond timestamp to. */
const spanWindowMs = ($: ColumnAccessor<typeof Traces.columns>): CH.Expr<number> =>
	CH.max_(CH.toUnixTimestamp64Nano($.Timestamp).add(CH.toInt64($.Duration)))
		.div(1_000_000)
		.sub(CH.min_(CH.toUnixTimestamp64Nano($.Timestamp)).div(1_000_000))

// Shared filters

export interface AgentSessionsFilterOpts {
	/** Only sessions/traces containing a span from ANY of these vendor slugs. */
	vendors?: readonly string[]
	/** Only sessions/traces containing an AI span from ANY of these services. */
	serviceNames?: readonly string[]
	/** Only sessions/traces containing at least one Error-status AI span. */
	hasErrors?: boolean
}

// Sessions list

export interface AgentSessionsListOpts extends AgentSessionsFilterOpts {
	limit?: number
	offset?: number
}

export interface AgentSessionsListOutput {
	/** `toString(AiSessionKeyHash)` — a UInt64 rides the JSON wire as a string
	 *  or corrupts above 2^53. Opaque id; the detail read resolves the display
	 *  key from span attributes. */
	readonly sessionKeyHash: string
	readonly startTime: string
	/** Start of the latest key-carrying span (its runtime is folded into
	 *  `durationMs`, not this timestamp). */
	readonly endTime: string
	readonly durationMs: number
	readonly traceCount: number
	/** Counts only the session-authoritative spans that carry the key — the
	 *  session's traces hold more spans, which the detail read fetches. Same
	 *  caveat for `errorCount`. */
	readonly keyedSpanCount: number
	readonly errorCount: number
	readonly vendors: ReadonlyArray<string>
	readonly serviceNames: ReadonlyArray<string>
}

export function agentSessionsListQuery(opts: AgentSessionsListOpts) {
	return from(Traces)
		.select(($) => ({
			sessionKeyHash: CH.toString_($.AiSessionKeyHash),
			startTime: CH.min_($.Timestamp),
			endTime: CH.max_($.Timestamp),
			durationMs: spanWindowMs($),
			traceCount: CH.uniq($.TraceId),
			keyedSpanCount: CH.count(),
			errorCount: CH.countIf($.StatusCode.eq("Error")),
			vendors: CH.groupUniqArray($.AiVendor),
			serviceNames: CH.groupUniqArray($.ServiceName),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.AiSessionKeyState.eq(SESSION_GRANULARITY),
		])
		.groupBy("sessionKeyHash")
		.having(($) => [
			containsAny(CH.groupUniqArray($.AiVendor), opts.vendors),
			containsAny(CH.groupUniqArray($.ServiceName), opts.serviceNames),
			CH.whenTrue(opts.hasErrors, () => CH.countIf($.StatusCode.eq("Error")).gt(0)),
		])
		.orderBy(["endTime", "desc"])
		.limit(opts.limit ?? 50)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

// AI traces list

export interface AgentTracesListOpts extends AgentSessionsFilterOpts {
	limit?: number
	offset?: number
}

export interface AgentTracesListOutput {
	readonly traceId: string
	readonly startTime: string
	readonly endTime: string
	/** Window of the trace's AI spans only — a trace's full wall time can be
	 *  wider (non-AI root, queue time). The trace detail view owns that number. */
	readonly durationMs: number
	readonly aiSpanCount: number
	readonly errorCount: number
	readonly vendors: ReadonlyArray<string>
	readonly serviceNames: ReadonlyArray<string>
	/** Earliest AI span's name, as a row label. */
	readonly firstSpanName: string
	/** max(AiSessionKeyState) across the trace's AI spans: 6 = belongs to a
	 *  session, anything lower explains why it doesn't (write-side enum). */
	readonly bestSessionKeyState: number
	/** Session-granularity key hash as a string, '' when the trace carries none.
	 *  A trace spanning several sessions surfaces one arbitrarily (max). */
	readonly sessionKeyHash: string
}

export function agentTracesListQuery(opts: AgentTracesListOpts) {
	return from(Traces)
		.select(($) => {
			const sessionHash = CH.maxIf($.AiSessionKeyHash, $.AiSessionKeyState.eq(SESSION_GRANULARITY))
			return {
				traceId: $.TraceId,
				startTime: CH.min_($.Timestamp),
				endTime: CH.max_($.Timestamp),
				durationMs: spanWindowMs($),
				aiSpanCount: CH.count(),
				errorCount: CH.countIf($.StatusCode.eq("Error")),
				vendors: CH.groupUniqArray($.AiVendor),
				serviceNames: CH.groupUniqArray($.ServiceName),
				firstSpanName: CH.argMin($.SpanName, $.Timestamp),
				bestSessionKeyState: CH.max_($.AiSessionKeyState),
				sessionKeyHash: CH.if_(sessionHash.gt(0), CH.toString_(sessionHash), CH.lit("")),
			}
		})
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.AiVendor.neq(""),
		])
		.groupBy("traceId")
		.having(($) => [
			containsAny(CH.groupUniqArray($.AiVendor), opts.vendors),
			containsAny(CH.groupUniqArray($.ServiceName), opts.serviceNames),
			CH.whenTrue(opts.hasErrors, () => CH.countIf($.StatusCode.eq("Error")).gt(0)),
		])
		.orderBy(["startTime", "desc"])
		.limit(opts.limit ?? 50)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

// Facets (UNION ALL — vendor / service / error count)
//
// Counts are per session or per trace depending on the tab, so every branch
// reads the same grouped subquery the list uses and applies the *other*
// dimensions' filters to it — a selected vendor doesn't collapse the vendor
// facet to one option, but does narrow the service counts, and vice versa.

export interface AgentSessionsFacetsOpts extends AgentSessionsFilterOpts {
	/** Which tab's counting unit to use: distinct sessions or distinct traces. */
	tab: "sessions" | "traces"
}

export type AgentSessionsFacetsOutput = FacetOutput

type AgentFacetKey = "vendor" | "service" | "error"

export function agentSessionsFacetsQuery(
	opts: AgentSessionsFacetsOpts,
): CHUnionQuery<AgentSessionsFacetsOutput> {
	const grouped = from(Traces)
		.select(($) => ({
			groupKey: opts.tab === "sessions" ? CH.toString_($.AiSessionKeyHash) : $.TraceId,
			vendors: CH.groupUniqArray($.AiVendor),
			serviceNames: CH.groupUniqArray($.ServiceName),
			errorCount: CH.countIf($.StatusCode.eq("Error")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			opts.tab === "sessions" ? $.AiSessionKeyState.eq(SESSION_GRANULARITY) : $.AiVendor.neq(""),
		])
		.groupBy("groupKey")

	// The fromQuery accessor's refs are untyped (`any`), so branch callbacks
	// funnel through this typed view of the grouped row.
	interface GroupedRefs {
		readonly vendors: CH.Expr<ReadonlyArray<string>>
		readonly serviceNames: CH.Expr<ReadonlyArray<string>>
		readonly errorCount: CH.Expr<number>
	}

	const otherFilters = (
		$: GroupedRefs,
		exclude: AgentFacetKey,
	): Array<CH.Condition | undefined> => [
		exclude === "vendor" ? undefined : containsAny($.vendors, opts.vendors),
		exclude === "service" ? undefined : containsAny($.serviceNames, opts.serviceNames),
		exclude === "error" ? undefined : CH.whenTrue(opts.hasErrors, () => $.errorCount.gt(0)),
	]

	// Each grouped row expands to one row per distinct array element, so a
	// mixed-vendor session counts once under every vendor it contains.
	const arrayFacet = (facetType: "vendor" | "service", column: "vendors" | "serviceNames") =>
		fromQuery(grouped, "g")
			.select(($: any) => ({
				name: CH.arrayJoin($[column] as CH.Expr<ReadonlyArray<string>>),
				count: CH.count(),
				facetType: CH.lit(facetType),
			}))
			.where(($: any) => otherFilters($, facetType))
			// ServiceName can legitimately be '' — dropped like every facet sidebar
			// does. Post-arrayJoin the alias only resolves in HAVING.
			.having(() => [CH.dynamicColumn<string>("name").neq("")])
			.groupBy("name")
			.orderBy(["count", "desc"])
			.limit(50)

	const errorFacet = fromQuery(grouped, "g")
		.select(() => ({
			name: CH.lit("error"),
			count: CH.count(),
			facetType: CH.lit("error"),
		}))
		.where(($: any) => [...otherFilters($, "error"), ($.errorCount as CH.Expr<number>).gt(0)])

	return unionAll(
		arrayFacet("vendor", "vendors"),
		arrayFacet("service", "serviceNames"),
		errorFacet,
	).format("JSON")
}

// Session detail (two-phase)
//
// Phase 1 resolves the session key hash to the session's TraceIds — only
// `AiSessionKeyState = 6` rows carry the hash. Phase 2 fetches ALL AI spans
// (`AiVendor != ''`) of those traces, because the session's substance usually
// lives on spans that do NOT carry the key: in the CrewAI shape the token
// counts sit on child openinference-openai LLM spans, and only the
// orchestration spans are keyed. Every fetched span runs through the vendor
// integration layer (`@maple/domain/ai`) on the read side; SpanAttributes
// travels whole because that layer owns which keys matter per vendor — a
// projected-key list here would couple the query to every integration's
// spellings.

/** Caps, not pagination: a session past either bound is degenerate (a leaked
 *  process-wide key) and the detail view is the wrong lens for it. The read
 *  layer reports truncation rather than silently pretending completeness. */
export const AGENT_SESSION_MAX_TRACES = 200
export const AGENT_SESSION_MAX_SPANS = 2000

export interface AgentSessionTraceIdsOutput {
	readonly traceId: string
	/** Window of the trace's KEY-CARRYING spans only — phase 2 re-derives real
	 *  bounds from all AI spans. These exist to give phase 2 a buffered
	 *  partition hint. */
	readonly startTime: string
	readonly endTime: string
}

export function agentSessionTraceIdsQuery() {
	return from(Traces)
		.select(($) => ({
			traceId: $.TraceId,
			startTime: CH.min_($.Timestamp),
			endTime: CH.max_($.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.AiSessionKeyState.eq(SESSION_GRANULARITY),
			// String-side comparison: the hash is a UInt64 identity and 2^53-unsafe,
			// so it crosses every boundary as a string (house rule).
			CH.toString_($.AiSessionKeyHash).eq(param.string("sessionKeyHash")),
		])
		.groupBy("traceId")
		.orderBy(["startTime", "asc"])
		.limit(AGENT_SESSION_MAX_TRACES)
		.format("JSON")
}

export interface AgentSessionSpansOpts {
	/** Phase-1 TraceIds. Values from our own warehouse, not user input. */
	traceIds: readonly string[]
}

export interface AgentSessionSpansOutput {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly timestamp: string
	readonly durationMs: number
	readonly spanName: string
	readonly spanKind: string
	readonly serviceName: string
	readonly statusCode: string
	readonly statusMessage: string
	readonly vendor: string
	readonly sessionKeyState: number
	readonly spanAttributes: Record<string, string>
}

/** The `startTime`/`endTime` params are buffered phase-1 bounds — a partition
 *  hint (the sort key is (OrgId, ServiceName, SpanName, Timestamp), so TraceId
 *  never seeks), padded by the caller so AI spans adjacent to the keyed window
 *  aren't clipped. */
export function agentSessionSpansQuery(opts: AgentSessionSpansOpts) {
	return from(Traces)
		.select(($) => ({
			traceId: $.TraceId,
			spanId: $.SpanId,
			parentSpanId: $.ParentSpanId,
			timestamp: $.Timestamp,
			durationMs: $.Duration.div(1_000_000),
			spanName: $.SpanName,
			spanKind: $.SpanKind,
			serviceName: $.ServiceName,
			statusCode: $.StatusCode,
			statusMessage: $.StatusMessage,
			vendor: $.AiVendor,
			sessionKeyState: $.AiSessionKeyState,
			spanAttributes: $.SpanAttributes,
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.TraceId.in_(...opts.traceIds),
			$.AiVendor.neq(""),
		])
		.orderBy(["timestamp", "asc"], ["spanId", "asc"])
		.limit(AGENT_SESSION_MAX_SPANS)
		.format("JSON")
}
