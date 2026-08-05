// ---------------------------------------------------------------------------
// Typed GenAI "Agentic Journey" Queries
//
// A **journey** is one end-to-end agent conversation, reconstructed from raw
// `traces` rows carrying the OTel GenAI semantic conventions (`gen_ai.*`).
// There is no materialized view and no new datasource: every `gen_ai.*`
// attribute already lands in `SpanAttributes`, so this is a read model.
//
// Four queries, all built on ONE per-span projection (`journeySpans`) so the
// list, the facet sidebar, the detail header, and the timeline can never
// disagree about what a journey is or which spans belong to it — the
// facet/filter invariant that has bitten trace facets before.
//
//   journeyListQuery      — paginated journey list (overview page)
//   journeyFacetsQuery    — facet values + counts for the sidebar
//   journeySummaryQuery   — one row for the detail header
//   journeyTimelineQuery  — every span of one journey, ordered by Timestamp
//
// ## Journey identity
//
// Three attributes compete for "which conversation is this span part of", and
// which one is present depends entirely on who instrumented the caller:
//
//   1. `gen_ai.conversation.id` — the semconv-blessed one
//   2. `session.id`             — what OpenRouter Broadcast emits for Maple's
//                                 own traffic (and browser SDKs, as a RESOURCE
//                                 attribute — both maps are checked)
//   3. `TraceId`                — always present, but only covers one turn
//
// The coalesce is resolved **per trace, not per span**: if only some spans of a
// conversation carry `conversation.id`, a per-span coalesce splits one journey
// into fragments (the bare spans fall back to their own `TraceId`). All spans of
// a trace share a `TraceId`, so `max(...) OVER (PARTITION BY TraceId)` picks the
// best key present *anywhere* in the trace before the fallback is considered —
// `''` sorts below every real value, so `max` is "any non-empty, else empty".
//
// ## Attribute churn
//
// `gen_ai.*` is still marked Development in the spec and has already renamed
// once (`gen_ai.system` → `gen_ai.provider.name`). Both generations are
// coalesced HERE, in one place, so the next rename is one edit rather than a
// sweep through components. Same `if(a != '', a, b)` shape `trace_list_mv` uses
// for `http.method` / `http.request.method`.
//
// ## Cost
//
// Cost has no stable semantic convention. Several emitter-specific keys are
// probed (`costRaw` reports whether ANY of them was present) and cost is
// nullable end to end — the header omits the stat rather than showing $0.00.
//
// ## Performance
//
// Every query scans raw `traces` over the requested window, filtered to
// `SpanAttributes['gen_ai.operation.name'] != ''`. That is deliberate for the
// first cut: a materialized view only populates going forward, so an MV-first
// build means waiting for data. When this gets slow, add `genai_spans_mv`
// sorted by `(OrgId, JourneyId, Timestamp)` and move the coalescing into the MV
// SQL — and keep the raw-table filter path normalizing identically, or filters
// will return zero rows against MV-derived facet counts.
// ---------------------------------------------------------------------------

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { compileFnCall, param } from "@maple-dev/clickhouse-builder"
import { from, fromQuery, unionAll } from "@maple-dev/clickhouse-builder"
import type {
	CHQuery,
	CHUnionQuery,
	ColumnAccessor,
	CompiledQueryRowSchema,
} from "@maple-dev/clickhouse-builder"
import { Traces } from "../tables"
import { CHNumber } from "../schema"
import type { FacetOutput } from "./query-helpers"

// ---------------------------------------------------------------------------
// Local function wrappers the DSL doesn't export
// ---------------------------------------------------------------------------

function arrayLength<T>(array: CH.Expr<ReadonlyArray<T>>): CH.Expr<number> {
	return compileFnCall<number>("length", array)
}

/**
 * `argMinIf(value, ordering, cond)` — the `value` from the row with the
 * smallest `ordering`, considering only rows matching `cond`. Returns the
 * type's default (`''` for String) when nothing matches.
 *
 * The `-If` combinator rather than a sentinel ordering key on purpose. The
 * obvious spelling of "sort the rows without content last" is
 * `argMin(x, if(cond, startNs, <huge>))` — and ClickHouse rejects it outright:
 * `startNs` is Float64, the sentinel literal is UInt64, and there is no
 * supertype ("some of them are integers and some are floating point, but there
 * is no floating point type that can exactly represent all required
 * integers"). Filtering instead of ranking sidesteps the mixed-type branch
 * altogether, and says what it means.
 */
function argMinIf<T>(value: CH.Expr<T>, ordering: CH.Expr<unknown>, cond: CH.Condition): CH.Expr<T> {
	return compileFnCall<T>("argMinIf", value, ordering, cond)
}

/**
 * `groupUniqArrayIf(maxSize)(value, cond)` — up to `maxSize` distinct values
 * from the rows matching `cond`. The size is a *parameter* of the aggregate,
 * not an argument, hence the name carrying it.
 */
function groupUniqArrayIf(
	maxSize: number,
	value: CH.Expr<string>,
	cond: CH.Condition,
): CH.Expr<ReadonlyArray<string>> {
	return compileFnCall<ReadonlyArray<string>>(`groupUniqArrayIf(${maxSize})`, value, cond)
}

function floor_(value: CH.Expr<number>): CH.Expr<number> {
	return compileFnCall<number>("floor", value)
}

function log2(value: CH.Expr<number>): CH.Expr<number> {
	return compileFnCall<number>("log2", value)
}

function pow(base: number, exponent: CH.Expr<number>): CH.Expr<number> {
	return compileFnCall<number>("pow", CH.lit(base), exponent)
}

/** `quantileIf(q)(value, cond)` — the parametric aggregate's curried spelling. */
function quantileIf(q: number, value: CH.Expr<number>, cond: CH.Condition): CH.Expr<number> {
	return compileFnCall<number>(`quantileIf(${q})`, value, cond)
}

/** `tuple('name', 'facetType', value)` — a packed stat row (see `numericStatsBranch`). */
function tuple3(name: string, facetType: string, value: CH.Expr<number>): CH.Expr<unknown> {
	return compileFnCall<unknown>("tuple", CH.lit(name), CH.lit(facetType), value)
}

function tupleElement<T>(value: CH.Expr<unknown>, index: number): CH.Expr<T> {
	return compileFnCall<T>("tupleElement", value, CH.lit(index))
}

// quantile() over an empty set yields nan, and casting nan to an integer throws.
function ifNotFinite(value: CH.Expr<number>, fallback: number): CH.Expr<number> {
	return compileFnCall<number>("ifNotFinite", value, CH.lit(fallback))
}

/** `if(a != '', a, if(b != '', b, …))` — first non-empty, left to right. */
function firstNonEmpty(...exprs: ReadonlyArray<CH.Expr<string>>): CH.Expr<string> {
	const [head, ...rest] = exprs
	if (!head) return CH.lit("")
	if (rest.length === 0) return head
	return CH.if_(head.neq(""), head, firstNonEmpty(...rest))
}

// ---------------------------------------------------------------------------
// Attribute vocabulary
// ---------------------------------------------------------------------------

/**
 * Operations that produce a model *turn*. `execute_tool`, `retrieval`, `plan`,
 * `invoke_agent`, `embeddings`, and memory operations are first-class span types
 * in the standard too — they land on the timeline as non-message events and are
 * deliberately NOT counted as turns.
 */
export const GENAI_INFERENCE_OPERATIONS = [
	"chat",
	"text_completion",
	"generate_content",
	"completion",
	"invoke_model",
] as const

/** `gen_ai.operation.name` for a tool execution span. */
export const GENAI_TOOL_OPERATION = "execute_tool"

/**
 * A journey whose last span landed within this many seconds of *now* is
 * reported as still running. GenAI spans are written when the operation ends,
 * so "no span for two minutes" is the only provider-agnostic signal available
 * — there is no in-progress marker in the conventions.
 */
export const JOURNEY_RUNNING_GRACE_SECONDS = 120

/** Cost keys, most-standard first. None of these is semconv-blessed (see header). */
const COST_ATTRIBUTE_KEYS = [
	"gen_ai.usage.cost",
	"gen_ai.usage.total_cost",
	"gen_ai.response.cost",
	"llm.usage.total_cost",
] as const

type TracesAccessor = ColumnAccessor<typeof Traces.columns>

const spanAttr = ($: TracesAccessor, key: string): CH.Expr<string> => $.SpanAttributes.get(key)
const resourceAttr = ($: TracesAccessor, key: string): CH.Expr<string> => $.ResourceAttributes.get(key)

/** Present on either map — `session.id` is a resource attribute for browser SDKs. */
const anyAttr = ($: TracesAccessor, key: string): CH.Expr<string> =>
	firstNonEmpty(spanAttr($, key), resourceAttr($, key))

const operationExpr = ($: TracesAccessor) => spanAttr($, "gen_ai.operation.name")
const providerExpr = ($: TracesAccessor) =>
	firstNonEmpty(spanAttr($, "gen_ai.provider.name"), spanAttr($, "gen_ai.system"))
const requestModelExpr = ($: TracesAccessor) => spanAttr($, "gen_ai.request.model")
const responseModelExpr = ($: TracesAccessor) => spanAttr($, "gen_ai.response.model")
/** What actually answered. Routers (OpenRouter) make requested ≠ served common. */
const servedModelExpr = ($: TracesAccessor) => firstNonEmpty(responseModelExpr($), requestModelExpr($))
const inputTokensExpr = ($: TracesAccessor) =>
	CH.toFloat64OrZero(
		firstNonEmpty(spanAttr($, "gen_ai.usage.input_tokens"), spanAttr($, "gen_ai.usage.prompt_tokens")),
	)
const outputTokensExpr = ($: TracesAccessor) =>
	CH.toFloat64OrZero(
		firstNonEmpty(
			spanAttr($, "gen_ai.usage.output_tokens"),
			spanAttr($, "gen_ai.usage.completion_tokens"),
		),
	)
const cachedTokensExpr = ($: TracesAccessor) =>
	CH.toFloat64OrZero(
		firstNonEmpty(
			spanAttr($, "gen_ai.usage.cached_input_tokens"),
			spanAttr($, "gen_ai.usage.cache_read_input_tokens"),
		),
	)
const reasoningTokensExpr = ($: TracesAccessor) =>
	CH.toFloat64OrZero(spanAttr($, "gen_ai.usage.reasoning_tokens"))
const costRawExpr = ($: TracesAccessor) => firstNonEmpty(...COST_ATTRIBUTE_KEYS.map((k) => spanAttr($, k)))
const agentNameExpr = ($: TracesAccessor) => anyAttr($, "gen_ai.agent.name")
const workflowNameExpr = ($: TracesAccessor) => anyAttr($, "gen_ai.workflow.name")
const inputMessagesExpr = ($: TracesAccessor) =>
	firstNonEmpty(spanAttr($, "gen_ai.input.messages"), spanAttr($, "gen_ai.prompt"))
const outputMessagesExpr = ($: TracesAccessor) =>
	firstNonEmpty(spanAttr($, "gen_ai.output.messages"), spanAttr($, "gen_ai.completion"))
const systemInstructionsExpr = ($: TracesAccessor) => spanAttr($, "gen_ai.system_instructions")
const toolNameExpr = ($: TracesAccessor) =>
	firstNonEmpty(spanAttr($, "gen_ai.request.tool.name"), spanAttr($, "gen_ai.tool.name"))

/**
 * Content can also arrive as span *events* (`gen_ai.content.prompt`,
 * `gen_ai.choice`, …) from OpenLLMetry and pre-1.37 SDKs. This pass reads
 * attributes only, but the count travels so an attribute-less span renders as
 * "content in events" instead of a crash or a broken-looking empty state.
 */
const contentEventCountExpr = ($: TracesAccessor) =>
	arrayLength(CH.arrayFilter("x -> x LIKE 'gen_ai.%'", $.EventsName))

/**
 * The derived `JourneyId`, resolved at TRACE granularity — see the header.
 * `$.TraceId` is the last resort, so a single-turn trace with no conversation
 * or session id is still a (one-turn) journey.
 */
function journeyIdExpr($: TracesAccessor): CH.Expr<string> {
	const perTrace = CH.windowSpec({ partitionBy: [$.TraceId] })
	const conversation = CH.over(CH.max_(anyAttr($, "gen_ai.conversation.id")), perTrace)
	const session = CH.over(CH.max_(anyAttr($, "session.id")), perTrace)
	return CH.multiIf(
		[
			[conversation.neq(""), conversation],
			[session.neq(""), session],
		],
		$.TraceId,
	)
}

// ---------------------------------------------------------------------------
// Per-span projection (the one source every journey query builds on)
// ---------------------------------------------------------------------------

export interface JourneySpanScanOpts {
	/**
	 * Narrow the scan to spans of one service — the only *row-level* filter here.
	 * Every journey-level filter is a HAVING (see `journeyHavingConditions`):
	 * dropping spans pre-aggregation would silently change a journey's token
	 * totals and turn count.
	 */
	serviceName?: string
}

/**
 * Every GenAI span in the window, with the attribute churn normalized and the
 * derived `journeyId` attached.
 *
 * Timestamps ride along as float nanoseconds (`startNs` / `endNs`) so the
 * aggregate can compute wall-clock duration across spans without a second
 * conversion; the float loses sub-microsecond precision at epoch-nanosecond
 * magnitudes, which is invisible in a millisecond output.
 */
function journeySpans(opts: JourneySpanScanOpts = {}) {
	return from(Traces)
		.select(($) => {
			const startNs = CH.toFloat64(CH.toUnixTimestamp64Nano($.Timestamp))
			const costRaw = costRawExpr($)
			return {
				journeyId: journeyIdExpr($),
				traceId: $.TraceId,
				spanId: $.SpanId,
				parentSpanId: $.ParentSpanId,
				timestamp: $.Timestamp,
				startNs,
				endNs: startNs.add(CH.toFloat64($.Duration)),
				durationMs: CH.toFloat64($.Duration).div(1_000_000),
				spanName: $.SpanName,
				serviceName: $.ServiceName,
				statusCode: $.StatusCode,
				statusMessage: $.StatusMessage,
				operation: operationExpr($),
				provider: providerExpr($),
				requestModel: requestModelExpr($),
				responseModel: responseModelExpr($),
				servedModel: servedModelExpr($),
				// `span`-prefixed because the journey aggregate sums these into
				// columns the API calls `inputTokens` / `cost` / …. Reusing the name
				// (`sum(inputTokens) AS inputTokens`) makes ClickHouse resolve the
				// alias — not the column — inside any OTHER aggregate expression that
				// mentions it, and reject the query with ILLEGAL_AGGREGATION
				// ("aggregate function found inside another aggregate function").
				// `totalTokens` is exactly that second reference.
				spanInputTokens: inputTokensExpr($),
				spanOutputTokens: outputTokensExpr($),
				spanCachedInputTokens: cachedTokensExpr($),
				spanReasoningTokens: reasoningTokensExpr($),
				costRaw,
				spanCost: CH.toFloat64OrZero(costRaw),
				finishReason: spanAttr($, "gen_ai.response.finish_reasons"),
				agentName: agentNameExpr($),
				agentId: anyAttr($, "gen_ai.agent.id"),
				workflowName: workflowNameExpr($),
				conversationId: anyAttr($, "gen_ai.conversation.id"),
				sessionId: anyAttr($, "session.id"),
				toolName: toolNameExpr($),
				toolCallId: spanAttr($, "gen_ai.tool.call.id"),
				toolType: firstNonEmpty(
					spanAttr($, "gen_ai.request.tool.type"),
					spanAttr($, "gen_ai.tool.type"),
				),
				toolArguments: spanAttr($, "gen_ai.tool.call.arguments"),
				toolResult: spanAttr($, "gen_ai.tool.call.result"),
				inputMessages: inputMessagesExpr($),
				outputMessages: outputMessagesExpr($),
				systemInstructions: systemInstructionsExpr($),
				contentEventCount: contentEventCountExpr($),
			}
		})
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			// The one thing that makes a span a GenAI span.
			operationExpr($).neq(""),
			CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
		])
}

/**
 * Accessor over `journeySpans`' output aliases. The DSL infers a subquery's
 * column types from its SELECT, but the aggregate and the timeline are written
 * against alias names rather than table columns, so this stays intentionally
 * loose — the compiled row shape is pinned by the exported `rowSchema`s instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JourneySpanAccessor = any

// ---------------------------------------------------------------------------
// Journey-level aggregate
// ---------------------------------------------------------------------------

export interface JourneyAggregateOutput {
	readonly journeyId: string
	/** Sample of the earliest span's `gen_ai.input.messages` (JSON, truncated).
	 *  The API derives the row title from it — the first *user* message — and
	 *  falls back down the ladder (agent → model → id) when it is `''`. */
	readonly titleSource: string
	readonly startTime: string
	readonly endTime: string
	readonly durationMs: number
	readonly traceCount: number
	readonly spanCount: number
	readonly turnCount: number
	readonly toolCallCount: number
	readonly toolErrorCount: number
	readonly errorCount: number
	readonly inputTokens: number
	readonly outputTokens: number
	readonly cachedInputTokens: number
	readonly reasoningTokens: number
	readonly totalTokens: number
	/** Summed cost. Meaningless unless `costSpanCount > 0` — see `costSpanCount`. */
	readonly cost: number
	/** Spans that carried any cost attribute. `0` ⇒ cost is unknown, not zero. */
	readonly costSpanCount: number
	readonly models: ReadonlyArray<string>
	readonly requestedModels: ReadonlyArray<string>
	readonly providers: ReadonlyArray<string>
	readonly agents: ReadonlyArray<string>
	readonly workflowName: string
	readonly finishReasons: ReadonlyArray<string>
	readonly serviceName: string
	/** Spans carrying any message content in *attributes*. `0` ⇒ redacted. */
	readonly contentSpanCount: number
	/** Spans carrying `gen_ai.*` span events (older SDKs put content there). */
	readonly contentEventSpanCount: number
	/** 1 when the last span landed inside the running grace window. */
	readonly isRunning: number
}

function journeyAggregateSelect($: JourneySpanAccessor) {
	const isInference = CH.inList($.operation, GENAI_INFERENCE_OPERATIONS as unknown as readonly string[])
	const isTool = $.operation.eq(GENAI_TOOL_OPERATION)
	const isError = $.statusCode.eq("Error")
	const hasContent = $.inputMessages.neq("").or($.outputMessages.neq("")).or($.systemInstructions.neq(""))
	// The earliest span that actually carries input content wins the title.
	// Content-less spans are excluded rather than ranked last, so a fully
	// redacted journey yields `''` — and the API falls back down the title
	// ladder — instead of an empty string that merely happened to be earliest.
	const hasInput = $.inputMessages.neq("")
	return {
		journeyId: $.journeyId,
		titleSource: CH.left_(argMinIf($.inputMessages, $.startNs, hasInput), CH.lit(2000)),
		startTime: CH.min_($.timestamp),
		endTime: CH.max_($.timestamp),
		// Each side is converted to milliseconds BEFORE the subtraction: written as
		// `max(a).sub(min(b)).div(1e6)` the DSL emits `max(a) - min(b) / 1e6`, which
		// by SQL precedence is `max(a) - (min(b)/1e6)` — an epoch-sized number, not a
		// duration. Same precedence trap as the apdex formula in query-helpers.
		durationMs: CH.max_<number>($.endNs).div(1_000_000).sub(CH.min_<number>($.startNs).div(1_000_000)),
		traceCount: CH.uniq($.traceId),
		spanCount: CH.count(),
		turnCount: CH.countIf(isInference),
		toolCallCount: CH.countIf(isTool),
		toolErrorCount: CH.countIf(isTool.and(isError)),
		errorCount: CH.countIf(isError),
		inputTokens: CH.sum($.spanInputTokens),
		outputTokens: CH.sum($.spanOutputTokens),
		cachedInputTokens: CH.sum($.spanCachedInputTokens),
		reasoningTokens: CH.sum($.spanReasoningTokens),
		totalTokens: CH.sum($.spanInputTokens).add(CH.sum($.spanOutputTokens)),
		cost: CH.sum($.spanCost),
		costSpanCount: CH.countIf($.costRaw.neq("")),
		models: groupUniqArrayIf(10, $.servedModel, $.servedModel.neq("")),
		requestedModels: groupUniqArrayIf(10, $.requestModel, $.requestModel.neq("")),
		providers: groupUniqArrayIf(5, $.provider, $.provider.neq("")),
		agents: groupUniqArrayIf(10, $.agentName, $.agentName.neq("")),
		workflowName: CH.max_($.workflowName),
		finishReasons: groupUniqArrayIf(5, $.finishReason, $.finishReason.neq("")),
		serviceName: CH.max_($.serviceName),
		contentSpanCount: CH.countIf(hasContent),
		contentEventSpanCount: CH.countIf($.contentEventCount.gt(0)),
		isRunning: CH.if_(
			CH.max_($.timestamp).gte(
				CH.rawExpr<string>(`now() - INTERVAL ${JOURNEY_RUNNING_GRACE_SECONDS} SECOND`),
			),
			CH.lit(1),
			CH.lit(0),
		),
	}
}

/** One row per journey, before any journey-level filter. */
function journeyAggregate(opts: JourneySpanScanOpts = {}) {
	return fromQuery(journeySpans(opts), "s")
		.select((($: any) => journeyAggregateSelect($)) as any)
		.groupBy("journeyId")
}

// ---------------------------------------------------------------------------
// Journey-level filters (HAVING — see JourneySpanScanOpts)
// ---------------------------------------------------------------------------

export type JourneyStatus = "ok" | "error" | "running"

export interface JourneyFilterOpts {
	/** Served model (`gen_ai.response.model`, falling back to the request model). */
	model?: string
	/** Requested model (`gen_ai.request.model`) — the router-divergence side. */
	requestedModel?: string
	provider?: string
	/** `gen_ai.agent.name` present anywhere in the journey. */
	agent?: string
	/** `gen_ai.workflow.name`. */
	workflow?: string
	serviceName?: string
	status?: JourneyStatus
	/** `gen_ai.response.finish_reasons` — `length` is a silent truncation. */
	finishReason?: string
	/** Only journeys that executed at least one tool. */
	hasTools?: boolean
	/** Only journeys whose message content was stripped (privacy modes). */
	contentRedacted?: boolean
	/** Case-insensitive substring over the title sample and the journey id. */
	search?: string
	durationMinMs?: number
	durationMaxMs?: number
	turnMin?: number
	turnMax?: number
	tokenMin?: number
	tokenMax?: number
	costMin?: number
	costMax?: number
}

/**
 * Which filter a facet branch must drop so its own selection doesn't collapse
 * it. Every filter in `JourneyFilterOpts` belongs to exactly one of these keys
 * — a filter with no key is one no branch can exclude, which is how a branch
 * ends up contradicting itself (its WHERE says "redacted", the inherited HAVING
 * says "not redacted", the count is 0 forever).
 *
 * `numeric` covers all four range filters as ONE group: the histogram and the
 * percentile chips share a single scan (see `numericStatsBranch`), so they
 * share an exclusion. The consequence is deliberate — the numeric facets
 * describe the population narrowed by the CATEGORICAL filters only, which is
 * what makes a range selection always widenable back out.
 */
type JourneyFacetKey =
	| "model"
	| "requestedModel"
	| "provider"
	| "agent"
	| "workflow"
	| "service"
	| "status"
	| "finishReason"
	| "tools"
	| "redacted"
	| "numeric"

const agg = <T>(alias: string): CH.Expr<T> => CH.dynamicColumn<T>(alias)

/**
 * The journey-level predicate set, as HAVING conditions over the aggregate's
 * output aliases. Shared verbatim by the list and every facet branch (each
 * dropping its own dimension) — that shared construction IS the facet/filter
 * invariant, not a convention someone has to remember.
 */
function journeyHavingConditions(
	opts: JourneyFilterOpts,
	exclude?: JourneyFacetKey,
): Array<CH.Condition | undefined> {
	const models = agg<ReadonlyArray<string>>("models")
	const requestedModels = agg<ReadonlyArray<string>>("requestedModels")
	const providers = agg<ReadonlyArray<string>>("providers")
	const agents = agg<ReadonlyArray<string>>("agents")
	const finishReasons = agg<ReadonlyArray<string>>("finishReasons")
	const errorCount = agg<number>("errorCount")
	const isRunning = agg<number>("isRunning")
	const toolCallCount = agg<number>("toolCallCount")
	const contentSpanCount = agg<number>("contentSpanCount")
	const durationMs = agg<number>("durationMs")
	const turnCount = agg<number>("turnCount")
	const totalTokens = agg<number>("totalTokens")
	const cost = agg<number>("cost")
	const title = agg<string>("titleSource")
	const journeyId = agg<string>("journeyId")
	const numeric = exclude !== "numeric"

	return [
		exclude === "model" ? undefined : CH.when(opts.model, (v: string) => CH.has(models, v)),
		exclude === "requestedModel"
			? undefined
			: CH.when(opts.requestedModel, (v: string) => CH.has(requestedModels, v)),
		exclude === "provider" ? undefined : CH.when(opts.provider, (v: string) => CH.has(providers, v)),
		exclude === "agent" ? undefined : CH.when(opts.agent, (v: string) => CH.has(agents, v)),
		exclude === "workflow"
			? undefined
			: CH.when(opts.workflow, (v: string) => agg<string>("workflowName").eq(v)),
		exclude === "service"
			? undefined
			: CH.when(opts.serviceName, (v: string) => agg<string>("serviceName").eq(v)),
		exclude === "finishReason"
			? undefined
			: CH.when(opts.finishReason, (v: string) => CH.has(finishReasons, v)),
		// A running journey outranks its (so far) clean status; an errored one
		// outranks running, so the three buckets partition the list exactly.
		exclude === "status"
			? undefined
			: opts.status === "error"
				? errorCount.gt(0)
				: opts.status === "running"
					? errorCount.eq(0).and(isRunning.eq(1))
					: opts.status === "ok"
						? errorCount.eq(0).and(isRunning.eq(0))
						: undefined,
		exclude === "tools" ? undefined : CH.whenTrue(opts.hasTools, () => toolCallCount.gt(0)),
		exclude === "redacted"
			? undefined
			: opts.contentRedacted === true
				? contentSpanCount.eq(0)
				: opts.contentRedacted === false
					? contentSpanCount.gt(0)
					: undefined,
		CH.when(opts.search, (v: string) =>
			CH.positionCaseInsensitive(title, CH.lit(v))
				.gt(0)
				.or(CH.positionCaseInsensitive(journeyId, CH.lit(v)).gt(0)),
		),
		// The four range filters are one exclusion group — see JourneyFacetKey.
		numeric && opts.durationMinMs != null ? durationMs.gte(opts.durationMinMs) : undefined,
		numeric && opts.durationMaxMs != null ? durationMs.lte(opts.durationMaxMs) : undefined,
		numeric && opts.turnMin != null ? turnCount.gte(opts.turnMin) : undefined,
		numeric && opts.turnMax != null ? turnCount.lte(opts.turnMax) : undefined,
		numeric && opts.tokenMin != null ? totalTokens.gte(opts.tokenMin) : undefined,
		numeric && opts.tokenMax != null ? totalTokens.lte(opts.tokenMax) : undefined,
		// A cost bound implicitly excludes journeys with no cost attribute at all:
		// an unknown cost cannot be said to fall within a bound (same reasoning as
		// the replays duration filter and its NULL in-progress sessions).
		numeric && opts.costMin != null
			? cost.gte(opts.costMin).and(agg<number>("costSpanCount").gt(0))
			: undefined,
		numeric && opts.costMax != null
			? cost.lte(opts.costMax).and(agg<number>("costSpanCount").gt(0))
			: undefined,
	]
}

// ---------------------------------------------------------------------------
// List query (overview page)
// ---------------------------------------------------------------------------

export type JourneySortKey = "startTime" | "duration" | "cost" | "turns" | "tokens"

export interface JourneyListOpts extends JourneyFilterOpts {
	/** "most expensive" / "slowest" / "most turns" are the natural entry points
	 *  into this data, so unlike replays the list is sortable. */
	sort?: JourneySortKey
	sortDirection?: "asc" | "desc"
	limit?: number
	offset?: number
}

export type JourneyListOutput = JourneyAggregateOutput

const SORT_COLUMN: Record<JourneySortKey, keyof JourneyAggregateOutput & string> = {
	startTime: "startTime",
	duration: "durationMs",
	cost: "cost",
	turns: "turnCount",
	tokens: "totalTokens",
}

export function journeyListQuery(opts: JourneyListOpts = {}): CHQuery<any, JourneyListOutput, {}> {
	const sortColumn = SORT_COLUMN[opts.sort ?? "startTime"]
	const direction = opts.sortDirection ?? "desc"
	return journeyAggregate({ serviceName: opts.serviceName })
		.having((() => journeyHavingConditions(opts)) as any)
		.orderBy([sortColumn, direction], ["journeyId", "desc"])
		.limit(opts.limit ?? 50)
		.offset(opts.offset ?? 0)
		.format("JSON") as CHQuery<any, JourneyListOutput, {}>
}

export const journeyListRowSchema: CompiledQueryRowSchema<JourneyListOutput> = Schema.Struct({
	journeyId: Schema.String,
	titleSource: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
	durationMs: CHNumber,
	traceCount: CHNumber,
	spanCount: CHNumber,
	turnCount: CHNumber,
	toolCallCount: CHNumber,
	toolErrorCount: CHNumber,
	errorCount: CHNumber,
	inputTokens: CHNumber,
	outputTokens: CHNumber,
	cachedInputTokens: CHNumber,
	reasoningTokens: CHNumber,
	totalTokens: CHNumber,
	cost: CHNumber,
	costSpanCount: CHNumber,
	models: Schema.Array(Schema.String),
	requestedModels: Schema.Array(Schema.String),
	providers: Schema.Array(Schema.String),
	agents: Schema.Array(Schema.String),
	workflowName: Schema.String,
	finishReasons: Schema.Array(Schema.String),
	serviceName: Schema.String,
	contentSpanCount: CHNumber,
	contentEventSpanCount: CHNumber,
	isRunning: CHNumber,
})

// ---------------------------------------------------------------------------
// Summary (detail header) — the same aggregate, pinned to one journey
// ---------------------------------------------------------------------------

export type JourneySummaryOutput = JourneyAggregateOutput

/**
 * Deliberately the *same* aggregate the list runs, filtered to one derived
 * `journeyId`: the header and the row can then never report different token
 * totals or a different turn count for the same journey.
 *
 * `journeyId` binds as a param, so the scan is still bounded only by the
 * caller's time window — pass the narrowest window the route knows.
 */
export function journeySummaryQuery(opts: JourneySpanScanOpts = {}) {
	return journeyAggregate(opts)
		.having((() => [agg<string>("journeyId").eq(param.string("journeyId"))]) as any)
		.limit(1)
		.format("JSON") as CHQuery<any, JourneySummaryOutput, {}>
}

export const journeySummaryRowSchema: CompiledQueryRowSchema<JourneySummaryOutput> = journeyListRowSchema

// ---------------------------------------------------------------------------
// Timeline (detail page) — every span of one journey, in order
// ---------------------------------------------------------------------------

export interface JourneyTimelineOpts extends JourneySpanScanOpts {
	limit?: number
	offset?: number
}

export interface JourneyTimelineOutput {
	readonly journeyId: string
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly timestamp: string
	readonly durationMs: number
	readonly spanName: string
	readonly serviceName: string
	readonly statusCode: string
	readonly statusMessage: string
	readonly operation: string
	readonly provider: string
	readonly requestModel: string
	readonly responseModel: string
	readonly servedModel: string
	readonly inputTokens: number
	readonly outputTokens: number
	readonly cachedInputTokens: number
	readonly reasoningTokens: number
	readonly cost: number
	readonly costRaw: string
	readonly finishReason: string
	readonly agentName: string
	readonly agentId: string
	readonly workflowName: string
	readonly conversationId: string
	readonly sessionId: string
	readonly toolName: string
	readonly toolCallId: string
	readonly toolType: string
	readonly toolArguments: string
	readonly toolResult: string
	/** `gen_ai.input.messages` (or legacy `gen_ai.prompt`). **Cumulative** — each
	 *  inference span repeats the whole prior conversation. Never render verbatim
	 *  across spans; see `buildJourneyTimeline`. `''` when redacted. */
	readonly inputMessages: string
	readonly outputMessages: string
	readonly systemInstructions: string
	readonly contentEventCount: number
}

/**
 * All spans of one journey, ordered by `Timestamp` — messages, tool calls,
 * retrievals, plans, agent invocations alike. The row model stays polymorphic
 * (one row per span, `operation` discriminating) precisely so non-message
 * operations and multi-agent handoffs slot in without a rewrite.
 */
export function journeyTimelineQuery(opts: JourneyTimelineOpts = {}) {
	return fromQuery(journeySpans(opts), "s")
		.select((($: any) => ({
			journeyId: $.journeyId,
			traceId: $.traceId,
			spanId: $.spanId,
			parentSpanId: $.parentSpanId,
			timestamp: $.timestamp,
			durationMs: $.durationMs,
			spanName: $.spanName,
			serviceName: $.serviceName,
			statusCode: $.statusCode,
			statusMessage: $.statusMessage,
			operation: $.operation,
			provider: $.provider,
			requestModel: $.requestModel,
			responseModel: $.responseModel,
			servedModel: $.servedModel,
			inputTokens: $.spanInputTokens,
			outputTokens: $.spanOutputTokens,
			cachedInputTokens: $.spanCachedInputTokens,
			reasoningTokens: $.spanReasoningTokens,
			cost: $.spanCost,
			costRaw: $.costRaw,
			finishReason: $.finishReason,
			agentName: $.agentName,
			agentId: $.agentId,
			workflowName: $.workflowName,
			conversationId: $.conversationId,
			sessionId: $.sessionId,
			toolName: $.toolName,
			toolCallId: $.toolCallId,
			toolType: $.toolType,
			toolArguments: $.toolArguments,
			toolResult: $.toolResult,
			inputMessages: $.inputMessages,
			outputMessages: $.outputMessages,
			systemInstructions: $.systemInstructions,
			contentEventCount: $.contentEventCount,
		})) as any)
		.where((($: any) => [$.journeyId.eq(param.string("journeyId"))]) as any)
		.orderBy(["timestamp", "asc"], ["spanId", "asc"])
		.limit(opts.limit ?? 500)
		.offset(opts.offset ?? 0)
		.format("JSON") as CHQuery<any, JourneyTimelineOutput, {}>
}

export const journeyTimelineRowSchema: CompiledQueryRowSchema<JourneyTimelineOutput> = Schema.Struct({
	journeyId: Schema.String,
	traceId: Schema.String,
	spanId: Schema.String,
	parentSpanId: Schema.String,
	timestamp: Schema.String,
	durationMs: CHNumber,
	spanName: Schema.String,
	serviceName: Schema.String,
	statusCode: Schema.String,
	statusMessage: Schema.String,
	operation: Schema.String,
	provider: Schema.String,
	requestModel: Schema.String,
	responseModel: Schema.String,
	servedModel: Schema.String,
	inputTokens: CHNumber,
	outputTokens: CHNumber,
	cachedInputTokens: CHNumber,
	reasoningTokens: CHNumber,
	cost: CHNumber,
	costRaw: Schema.String,
	finishReason: Schema.String,
	agentName: Schema.String,
	agentId: Schema.String,
	workflowName: Schema.String,
	conversationId: Schema.String,
	sessionId: Schema.String,
	toolName: Schema.String,
	toolCallId: Schema.String,
	toolType: Schema.String,
	toolArguments: Schema.String,
	toolResult: Schema.String,
	inputMessages: Schema.String,
	outputMessages: Schema.String,
	systemInstructions: Schema.String,
	contentEventCount: CHNumber,
})

// ---------------------------------------------------------------------------
// Facets (filter sidebar)
//
// Same shape as the replays sidebar: one UNION ALL, `{name, count, facetType}`
// per row, each categorical branch dropping its OWN dimension's filter so a
// selected value still shows its alternatives. Counts are journeys, not spans —
// every branch aggregates to journeys first, then counts distinct `journeyId`.
//
// Multi-valued dimensions (a journey can use three models) are exploded with
// `arrayJoin` over the aggregate's array, so a journey contributes one count to
// each model it actually used.
//
// COST: twelve branches, each re-running the journey aggregate over raw
// `traces` — and the per-span projection is repeated in each, so the compiled
// SQL is ~90 KB (it lands verbatim in the `db.query.text` span attribute). The
// numeric percentiles are already collapsed into one branch (see
// `numericStatsBranch`); the rest need different filter exclusions and can't
// share a scan without a CTE the branches could read, which the union builder
// can't express while keeping each branch's tenant scope derivable. The real
// fix is `genai_spans_mv` — at which point a branch is a range scan and this
// stops mattering. Until then, prefer fetching facets less often over adding
// more dimensions.
// ---------------------------------------------------------------------------

export type JourneyFacetsOpts = JourneyFilterOpts

export type JourneyFacetsOutput = FacetOutput

/**
 * `uniq()` and `toUInt64()` are UInt64, which ClickHouse's `FORMAT JSON` quotes
 * as a string while Tinybird returns a number. Pass this to
 * `compileUnion(..., { rowSchema })` — without it the route is coercing at the
 * edge, and any wire drift degrades to a silent `NaN` instead of a tagged
 * decode error.
 */
export const journeyFacetsRowSchema: CompiledQueryRowSchema<JourneyFacetsOutput> = Schema.Struct({
	name: Schema.String,
	count: CHNumber,
	facetType: Schema.String,
})

export function journeyFacetsQuery(opts: JourneyFacetsOpts = {}): CHUnionQuery<JourneyFacetsOutput> {
	// `serviceName` is the one filter that is also a row-level scan narrowing;
	// its own facet branch has to drop it in BOTH places or the branch collapses.
	const scan = (exclude?: JourneyFacetKey) => ({
		serviceName: exclude === "service" ? undefined : opts.serviceName,
	})

	const journeys = (exclude?: JourneyFacetKey) =>
		journeyAggregate(scan(exclude)).having((() => journeyHavingConditions(opts, exclude)) as any)

	/** Facet over an array-valued dimension (models, providers, agents, …). */
	const arrayFacet = (facetType: string, exclude: JourneyFacetKey, column: string, limit = 50) =>
		fromQuery(journeys(exclude), "j")
			.select((($: any) => ({
				name: CH.arrayJoin<string>($[column]),
				count: CH.uniq($.journeyId),
				facetType: CH.lit(facetType),
			})) as any)
			.groupBy("name")
			.orderBy(["count", "desc"])
			.limit(limit)

	/** Facet over a scalar dimension. */
	const scalarFacet = (facetType: string, exclude: JourneyFacetKey, column: string, limit = 50) =>
		fromQuery(journeys(exclude), "j")
			.select((($: any) => ({
				name: $[column],
				count: CH.uniq($.journeyId),
				facetType: CH.lit(facetType),
			})) as any)
			.where((($: any) => [$[column].neq("")]) as any)
			.groupBy("name")
			.orderBy(["count", "desc"])
			.limit(limit)

	/** One row per status bucket, from a single pass over the unfiltered-by-status set. */
	const statusFacet = (name: string, predicate: ($: any) => CH.Condition) =>
		fromQuery(journeys("status"), "j")
			.select((($: any) => ({
				name: CH.lit(name),
				count: CH.uniq($.journeyId),
				facetType: CH.lit("status"),
			})) as any)
			.where((($: any) => [predicate($)]) as any)

	// Half-octave log buckets from 1s, exactly as the replays duration histogram
	// does it — the sidebar derives each ceiling as floor × √2 rather than
	// duplicating the formula.
	const bucketFloorMs = ($: any): CH.Expr<number> =>
		CH.round_(
			pow(2, floor_(log2(CH.greatest_($.durationMs, CH.lit(1000)).div(1000)).mul(2)).div(2)).mul(1000),
		)

	// Excludes the numeric group: a histogram drawn from journeys that already
	// passed the duration filter shows one occupied bucket and no way back out.
	const durationHistogram = fromQuery(journeys("numeric"), "j")
		.select((($: any) => ({
			name: CH.toString_(CH.toUInt64(bucketFloorMs($))),
			count: CH.uniq($.journeyId),
			facetType: CH.lit("durationBucket"),
		})) as any)
		.groupBy("name")
		.limit(40)

	return unionAll(
		arrayFacet("model", "model", "models"),
		arrayFacet("provider", "provider", "providers"),
		arrayFacet("agent", "agent", "agents"),
		arrayFacet("finishReason", "finishReason", "finishReasons"),
		scalarFacet("workflow", "workflow", "workflowName"),
		scalarFacet("service", "service", "serviceName"),
		statusFacet("error", ($) => $.errorCount.gt(0)),
		statusFacet("running", ($) => $.errorCount.eq(0).and($.isRunning.eq(1))),
		statusFacet("ok", ($) => $.errorCount.eq(0).and($.isRunning.eq(0))),
		// Toggle counts. Each drops only its own filter, like the status branches.
		fromQuery(journeys("tools"), "j")
			.select((($: any) => ({
				name: CH.lit("tools"),
				count: CH.uniq($.journeyId),
				facetType: CH.lit("tools"),
			})) as any)
			.where((($: any) => [$.toolCallCount.gt(0)]) as any),
		// Its own `contentRedacted` filter is dropped here for the same reason the
		// status branches drop theirs: with `contentRedacted: false` active, an
		// inherited `contentSpanCount > 0` would contradict this branch's own
		// `contentSpanCount = 0` and the toggle would read 0 journeys forever.
		fromQuery(journeys("redacted"), "j")
			.select((($: any) => ({
				name: CH.lit("redacted"),
				count: CH.uniq($.journeyId),
				facetType: CH.lit("redacted"),
			})) as any)
			.where((($: any) => [$.contentSpanCount.eq(0)]) as any),
		durationHistogram,
		numericStatsBranch(journeys("numeric")),
	).format("JSON") as CHUnionQuery<JourneyFacetsOutput>
}

/**
 * All eight numeric percentiles — duration, turns, tokens, cost — as one branch
 * over ONE pass of the journey aggregate.
 *
 * The obvious spelling is eight `quantile` branches, but every branch of this
 * UNION re-runs the whole journey aggregate (a full `traces` scan over the
 * window), and they all describe the *same* population. So the quantiles are
 * computed together, packed into an array of `(name, facetType, value)` tuples,
 * and unpacked with a single `arrayJoin` — 8 scans become 1, and the compiled
 * SQL loses ~30 KB.
 *
 * The `arrayJoin` needs its own subquery level: reading `tupleElement` off it
 * three times in one SELECT would expand the array three times over.
 *
 * The `toUInt64` cast on the value is load-bearing — every other branch's count
 * is `uniq()`'s UInt64, and ClickHouse refuses a UNION ALL that mixes it with
 * `quantile()`'s Float64 ("no supertype for types Float64, UInt64"). Cost is
 * therefore carried in **micro-dollars**: a p95 of $0.004 would otherwise round
 * to 0. The client divides by 1e6. `ifNotFinite` guards the empty window, where
 * `quantile` returns nan and the cast would throw.
 */
function numericStatsBranch(journeys: any) {
	const stats = fromQuery(journeys, "j").select((($: any) => ({
		durationP50: CH.quantile(0.5)($.durationMs),
		durationP95: CH.quantile(0.95)($.durationMs),
		turnP50: CH.quantile(0.5)($.turnCount),
		turnP95: CH.quantile(0.95)($.turnCount),
		tokenP50: CH.quantile(0.5)($.totalTokens),
		tokenP95: CH.quantile(0.95)($.totalTokens),
		// Cost percentiles describe only journeys whose emitter sent a cost at
		// all — a journey with unknown cost is not a $0 journey.
		costP50: quantileIf(0.5, $.cost, $.costSpanCount.gt(0)).mul(1_000_000),
		costP95: quantileIf(0.95, $.cost, $.costSpanCount.gt(0)).mul(1_000_000),
	})) as any)

	const exploded = fromQuery(stats, "q").select((($: any) => ({
		stat: CH.arrayJoin(
			CH.arrayOf(
				tuple3("p50", "durationStat", $.durationP50),
				tuple3("p95", "durationStat", $.durationP95),
				tuple3("p50", "turnStat", $.turnP50),
				tuple3("p95", "turnStat", $.turnP95),
				tuple3("p50", "tokenStat", $.tokenP50),
				tuple3("p95", "tokenStat", $.tokenP95),
				tuple3("p50", "costStat", $.costP50),
				tuple3("p95", "costStat", $.costP95),
			),
		),
	})) as any)

	return fromQuery(exploded, "r").select((($: any) => ({
		name: tupleElement<string>($.stat, 1),
		count: CH.toUInt64(ifNotFinite(CH.round_(tupleElement<number>($.stat, 3)), 0)),
		facetType: tupleElement<string>($.stat, 2),
	})) as any)
}
