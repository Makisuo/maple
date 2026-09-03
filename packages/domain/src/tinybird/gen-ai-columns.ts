// The facts of one GenAI span that `ai_trace_index` carries, as SQL.
//
// Every AI framework speaks its own attribute dialect, and the read side
// reconciles them per vendor in `@maple/query-engine-integrations` — after the
// spans are already in hand. The index has no such luxury: its materialized
// view sees one span at a time, at insert, and has to settle the model, the
// agent, the tool, the usage and the span's kind right then. So every rule
// lives here, as SQL the view compiles from — the same contract as
// `semconv-renames.ts`, for the same reason: the index's column and any
// raw-table read of the same fact must agree byte for byte, or a filter
// selects a population the facet never counted.
//
// The key lists mirror the sources the integrations layer decodes (its default
// `gen_ai.*` keys plus the Vercel AI SDK and OpenInference dialects), and the
// classification rules transcribe `classifyAiSpan`/`isLlmCall`
// (`apps/web/src/lib/agent-sessions/session-turns.ts`) and `spanTokenBuckets`
// (`session-summary.ts`) — so a session's "12 calls · $0.40" in the list agrees
// with its own overview. `ai-span-columns.test.ts` in the integrations package
// pins every key list to that layer's own alias tables, so a key added on one
// side cannot drift silently.

import type { Condition, Expr } from "@maple-dev/clickhouse-builder/expr"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { compile } from "@maple-dev/clickhouse-builder/sql"

/** A `$.SpanAttributes`-shaped accessor: the builder's own, or the bare-column
 *  stand-in the SQL text below is compiled from. */
export interface MapColumnLike {
	get(key: string): Expr<string>
}

/** The span columns the classification and failure rules read alongside the
 *  attribute Map. */
export interface GenAiSpanColumnsLike {
	readonly SpanName: Expr<string>
	readonly StatusCode: Expr<string>
	readonly SpanAttributes: MapColumnLike
}

const mapColumn = (name: string): MapColumnLike => {
	const column = CH.dynamicColumn<Record<string, string>>(name)
	return { get: (key) => CH.mapGet(column, key) }
}

/** The bare `traces` columns, for the SQL text the view is rendered from. */
const rawSpan: GenAiSpanColumnsLike = {
	SpanName: CH.dynamicColumn<string>("SpanName"),
	StatusCode: CH.dynamicColumn<string>("StatusCode"),
	SpanAttributes: mapColumn("SpanAttributes"),
}

const sql = (expr: Expr<unknown> | Condition): string => compile(expr.toFragment())

/**
 * The first non-empty value among `keys`, else `''`.
 *
 * Map lookups return `''` for a missing key, so each candidate but the last is
 * wrapped in `nullIf` to become a `coalesce` fallback. The last stays a bare
 * lookup so the whole expression is a non-Nullable `String` — it feeds a
 * non-Nullable MV column, and `''` is what "none" reads as everywhere else.
 */
export const firstNonEmptyAttr = (attrs: MapColumnLike, keys: ReadonlyArray<string>): Expr<string> => {
	const last = keys[keys.length - 1]
	if (last === undefined) throw new Error("firstNonEmptyAttr needs at least one key")
	const candidates = keys.slice(0, -1).map((key) => CH.nullIf(attrs.get(key), ""))
	return candidates.length === 0 ? attrs.get(last) : CH.coalesce(...candidates, attrs.get(last))
}

// Identity — model, agent, tool

/**
 * The model a span ran on. Response model first, because it is the one the
 * provider actually served — an alias or a "latest" tag in the request
 * resolves to a dated snapshot in the response — then the request model, then
 * the Vercel AI SDK and OpenInference spellings of the same two.
 */
export const GENAI_MODEL_KEYS = [
	"gen_ai.response.model",
	"gen_ai.request.model",
	"ai.response.model",
	"ai.model.id",
	"llm.model_name",
] as const

/** The agent that owns the span. `ai.telemetry.functionId` is the name an app
 *  gave a traced Vercel AI SDK call — the only agent identity an older-SDK span
 *  has, and in production the same value the sibling `invoke_agent` span puts in
 *  `gen_ai.agent.name`. */
export const GENAI_AGENT_NAME_KEYS = ["gen_ai.agent.name", "ai.telemetry.functionId"] as const

/** The tool an `execute_tool` span ran. */
export const GENAI_TOOL_NAME_KEYS = ["gen_ai.tool.name", "ai.toolCall.name", "tool.name"] as const

export function genAiModelExpr(spanAttributes: MapColumnLike): Expr<string> {
	return firstNonEmptyAttr(spanAttributes, GENAI_MODEL_KEYS)
}

export function genAiAgentNameExpr(spanAttributes: MapColumnLike): Expr<string> {
	return firstNonEmptyAttr(spanAttributes, GENAI_AGENT_NAME_KEYS)
}

export function genAiToolNameExpr(spanAttributes: MapColumnLike): Expr<string> {
	return firstNonEmptyAttr(spanAttributes, GENAI_TOOL_NAME_KEYS)
}

// Operation and kind — is this span a model call, a tool call?

const INFERENCE_OPS = ["chat", "generate_content", "text_completion", "fetch_response"] as const
const RETRIEVAL_OPS = ["embeddings", "retrieval"] as const
const TOOL_OPS = ["execute_tool"] as const
const AGENT_OPS = ["invoke_agent", "create_agent", "invoke_workflow", "plan", "agent_step"] as const
const KNOWN_OPS = [...INFERENCE_OPS, ...RETRIEVAL_OPS, ...TOOL_OPS, ...AGENT_OPS]

/** `openinference.span.kind` → the operation the integration layer would
 *  refine it to. Mirrors `OPENINFERENCE_SPAN_KIND_OPERATIONS` in `ai-vendors.ts`. */
export const OPENINFERENCE_KIND_OPERATIONS = [
	["LLM", "chat"],
	["TOOL", "execute_tool"],
	["AGENT", "invoke_agent"],
	["EMBEDDING", "embeddings"],
	["RETRIEVER", "retrieval"],
] as const

/** The span's operation: `gen_ai.operation.name`, else the OpenInference kind
 *  translated, else `''`. */
export function genAiOperationExpr(attrs: MapColumnLike): Expr<string> {
	const kind = attrs.get("openinference.span.kind")
	return CH.coalesce(
		CH.nullIf(attrs.get("gen_ai.operation.name"), ""),
		CH.multiIf(
			OPENINFERENCE_KIND_OPERATIONS.map(([from, to]): [Condition, Expr<string>] => [
				kind.eq(from),
				CH.lit(to),
			]),
			CH.lit(""),
		),
	)
}

/**
 * `classifyAiSpan`'s span-name fallback, for a span whose operation is absent
 * or one the convention does not name (`generate_text`): tool, then agent,
 * then inference — in that order, because the first rule that fires wins in
 * the client too.
 */
const nameLooks = (name: Expr<string>, needles: readonly [string, ...string[]]): Condition => {
	const lowered = CH.lower_(name)
	const [first, ...rest] = needles
	return rest.reduce((cond, needle) => cond.or(lowered.like(`%${needle}%`)), lowered.like(`%${first}%`))
}

/** A model turn — what the list counts as an "LLM call". Embeddings and
 *  retrieval are inference time but not calls, exactly as `isLlmCall` says.
 *  Every span the index holds is vendor-stamped, so the client's "is an AI
 *  span" guard on the name rules is already met. */
export function genAiIsLlmCallCond($: Pick<GenAiSpanColumnsLike, "SpanName" | "SpanAttributes">): Condition {
	const attrs = $.SpanAttributes
	const op = genAiOperationExpr(attrs)
	const byOperation = CH.inList(op, INFERENCE_OPS)
	const byName = CH.notInList(op, KNOWN_OPS)
		.and(
			CH.not(
				genAiToolNameExpr(attrs)
					.neq("")
					.or(nameLooks($.SpanName, ["tool"])),
			),
		)
		.and(CH.not(nameLooks($.SpanName, ["agent", "workflow"])))
		.and(
			genAiModelExpr(attrs)
				.neq("")
				.or(nameLooks($.SpanName, ["chat", "completion"])),
		)
	return byOperation.or(byName)
}

export function genAiIsToolCallCond($: Pick<GenAiSpanColumnsLike, "SpanName" | "SpanAttributes">): Condition {
	const attrs = $.SpanAttributes
	const op = genAiOperationExpr(attrs)
	const byOperation = CH.inList(op, TOOL_OPS)
	const byName = CH.notInList(op, KNOWN_OPS).and(
		genAiToolNameExpr(attrs)
			.neq("")
			.or(nameLooks($.SpanName, ["tool"])),
	)
	return byOperation.or(byName)
}

// Failure

/** `gen_ai.response.status` values that mean the generation failed — semconv's
 *  `failed` plus the pre-enum `error` dialect. Mirrors `spanFailed` in
 *  `session-turns.ts`. */
export const GENAI_FAILED_RESPONSE_STATUSES = ["failed", "error"] as const

/**
 * The span failed: by its own status, or by an attribute-declared failure —
 * frameworks record a failed model or tool call as a VALUE on an `Ok` span.
 * Scoped to GenAI spans by construction (every index row is one), which is
 * what keeps an HTTP span's `error.type` on an expected 4xx out of it.
 */
export function genAiIsErrorCond($: Pick<GenAiSpanColumnsLike, "StatusCode" | "SpanAttributes">): Condition {
	const attrs = $.SpanAttributes
	return $.StatusCode.eq("Error")
		.or(attrs.get("error.type").neq(""))
		.or(CH.inList(attrs.get("gen_ai.response.status"), GENAI_FAILED_RESPONSE_STATUSES))
}

// Usage — the five disjoint token buckets `spanTokenBuckets` sums, each under
// its canonical key, its legacy `gen_ai.*` alias, and the Vercel AI SDK and
// OpenInference spellings. Canonical first: a span carrying both spellings is
// read the way the integration layer reads it.

export const GENAI_USAGE_KEYS = {
	input: [
		"gen_ai.usage.input_tokens",
		"gen_ai.usage.prompt_tokens",
		"ai.usage.inputTokens",
		"ai.usage.promptTokens",
		"llm.token_count.prompt",
	],
	cacheRead: [
		"gen_ai.usage.cache_read.input_tokens",
		"gen_ai.usage.input_tokens.cached",
		"ai.usage.cachedInputTokens",
		"ai.usage.inputTokenDetails.cacheReadTokens",
		"llm.token_count.prompt_details.cache_read",
	],
	cacheWrite: [
		"gen_ai.usage.cache_creation.input_tokens",
		"gen_ai.usage.cache_write.input_tokens",
		"ai.usage.inputTokenDetails.cacheWriteTokens",
	],
	output: [
		"gen_ai.usage.output_tokens",
		"gen_ai.usage.completion_tokens",
		"ai.usage.outputTokens",
		"ai.usage.completionTokens",
		"llm.token_count.completion",
	],
	reasoning: [
		"gen_ai.usage.reasoning.output_tokens",
		"gen_ai.usage.output_tokens.reasoning",
		"ai.usage.reasoningTokens",
		"ai.usage.outputTokenDetails.reasoningTokens",
		"llm.token_count.completion_details.reasoning",
	],
} as const

export const GENAI_COST_KEYS = ["gen_ai.usage.cost", "gen_ai.usage.total_cost", "llm.cost.total"] as const

const tokenBucket = (attrs: MapColumnLike, keys: ReadonlyArray<string>): Expr<number> =>
	CH.toFloat64OrZero(firstNonEmptyAttr(attrs, keys))

/** Every token the span reported, across the five buckets. `toFloat64OrZero`
 *  rather than a UInt64 parse: a dialect that writes `1234.0` still counts, and
 *  the sums never approach 2^53. */
export function genAiTokensExpr(attrs: MapColumnLike): Expr<number> {
	const buckets = Object.values(GENAI_USAGE_KEYS).map((keys) => tokenBucket(attrs, keys))
	return buckets.reduce((sum, bucket) => sum.add(bucket))
}

/** USD as the instrumentation priced the call; 0 where nothing did. */
export function genAiCostExpr(attrs: MapColumnLike): Expr<number> {
	return CH.toFloat64OrZero(firstNonEmptyAttr(attrs, GENAI_COST_KEYS))
}

/** A flag column: `1` where the condition holds. */
const flag = (cond: Condition): Expr<number> => CH.compileFnCall<number>("toUInt8", cond)

/**
 * SQL text for the materialized view and the migration DDL. Each compiles
 * byte-identically to its builder form applied to the raw `traces` columns, so
 * the index's pre-extracted value and a read straight off the raw table resolve
 * the same span to the same value.
 */
export const GENAI_MODEL_SQL = sql(genAiModelExpr(rawSpan.SpanAttributes))
export const GENAI_AGENT_NAME_SQL = sql(genAiAgentNameExpr(rawSpan.SpanAttributes))
export const GENAI_TOOL_NAME_SQL = sql(genAiToolNameExpr(rawSpan.SpanAttributes))
export const GENAI_IS_LLM_CALL_SQL = sql(flag(genAiIsLlmCallCond(rawSpan)))
export const GENAI_IS_TOOL_CALL_SQL = sql(flag(genAiIsToolCallCond(rawSpan)))
export const GENAI_IS_ERROR_SQL = sql(flag(genAiIsErrorCond(rawSpan)))
export const GENAI_TOKENS_SQL = sql(genAiTokensExpr(rawSpan.SpanAttributes))
export const GENAI_COST_SQL = sql(genAiCostExpr(rawSpan.SpanAttributes))
