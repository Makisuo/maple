// Everything the session header states, derived from the spans.
//
// Three rules shape this module. Time is measured as *occupancy* of the wall
// clock, never as a sum of span durations — a session running four tools in
// parallel would otherwise report 180% of itself. Tokens are counted at the
// deepest span that reports them, because frameworks that also roll usage up to
// the agent span would otherwise double the bill. And a token total is only ever
// added up per the convention the reporting provider bills under: most of them
// count cached tokens inside the prompt figure, and summing the buckets there
// would bill the cache twice.

import type { AiSessionSpan } from "@maple/domain/http"
import {
	classifyAiSpan,
	isLlmCall,
	spanEndMs,
	spanModel,
	spanStartMs,
	spanTtftMs,
	type SessionTurn,
} from "./session-turns"

/**
 * Shortest hole in the session that counts as the user thinking rather than the
 * framework working. Below it, a gap is overhead and stays in active time.
 */
const IDLE_GAP_MIN_MS = 5_000

export interface IdleGap {
	readonly id: string
	readonly startMs: number
	readonly endMs: number
	readonly durationMs: number
}

/** Wall-clock occupancy classes, in the order the breakdown bar draws them. */
export type OccupancyKind = "idle" | "ttft" | "inference" | "tool" | "unaccounted"

export interface OccupancySegment {
	readonly kind: OccupancyKind
	readonly ms: number
}

export interface SessionTokenTotals {
	readonly input: number
	readonly cacheRead: number
	readonly cacheWrite: number
	readonly output: number
	readonly reasoning: number
	/**
	 * What the buckets add up to under the reporting provider's convention —
	 * which is not always their sum. See `cacheInclusiveInput`.
	 */
	readonly total: number
}

/**
 * Where the session's usage figures came from, so a view can say why a number
 * is missing rather than printing a zero it cannot stand behind.
 *
 * - `per-call` — each model call reported its own usage.
 * - `roll-up` — a wrapper span reported the sum of calls that also reported.
 * - `session-level` — every figure comes from a span covering more than one
 *   turn, so the session has a total and the individual turns do not.
 * - `none` — nothing reported usage.
 */
export type SessionTokenReporting = "per-call" | "roll-up" | "session-level" | "none"

export interface SessionModelUsage {
	readonly model: string
	readonly llmCalls: number
	readonly tokens: SessionTokenTotals
	/** Reported spend over this model's calls, or nothing when none of them
	 *  carried a cost — the same rule the session's own `cost` follows. */
	readonly cost: number | undefined
}

/** One tool, and how many times the session called it. */
export interface SessionToolUsage {
	readonly name: string
	readonly calls: number
}

/** How a failure is named on the page — the bucket it counts in, and the label
 *  the breakdown groups by. */
export type SessionFailureKind = "error" | "rateLimited" | "contextExceeded" | "refusal"

export interface SessionFailureEvent {
	readonly kind: SessionFailureKind
	/** What went wrong, in the instrumentation's own vocabulary. */
	readonly label: string
	readonly span: AiSessionSpan
}

/** Failure events sharing a label, counted. */
export interface SessionFailureGroup {
	readonly kind: SessionFailureKind
	readonly label: string
	readonly count: number
}

export interface SessionWorkCounts {
	readonly turns: number
	readonly llmCalls: number
	readonly toolCalls: number
}

export interface SessionFailureCounts {
	/** Every errored span not named by one of the buckets below. */
	readonly errors: number
	readonly rateLimited: number
	readonly contextExceeded: number
	readonly refusals: number
}

export interface SessionSummary {
	readonly startMs: number
	readonly endMs: number
	readonly wallClockMs: number
	readonly activeMs: number
	readonly idleMs: number
	readonly idleGaps: readonly IdleGap[]
	/** Non-zero segments only: an unavailable TTFT is absent, never a zero bar. */
	readonly occupancy: readonly OccupancySegment[]
	/** The last turn did not close cleanly. */
	readonly failed: boolean
	/** The opening user message, when content was captured. */
	readonly title: string | undefined
	readonly agentNames: readonly string[]
	readonly vendorIds: readonly string[]
	readonly serviceNames: readonly string[]
	readonly models: readonly SessionModelUsage[]
	readonly tokens: SessionTokenTotals
	/** How those tokens were reported — the one thing a per-turn number cannot
	 *  express, and the reason a turn may have none. */
	readonly tokenReporting: SessionTokenReporting
	/**
	 * Spend in USD as the instrumentation reported it. Maple does not price
	 * tokens itself: no convention attribute carries a price, so only spans
	 * stamped with one by an instrumentation that did its own pricing
	 * (`gen_ai.usage.cost` and its vendor spellings) contribute. `undefined`
	 * when no span reported a cost at all.
	 */
	readonly cost: number | undefined
	readonly work: SessionWorkCounts
	readonly failures: SessionFailureCounts
	/** The same failures those counts tally, grouped by what they say went wrong
	 *  and ordered busiest first. */
	readonly failureGroups: readonly SessionFailureGroup[]
	/** Tools by call count, busiest first. */
	readonly tools: readonly SessionToolUsage[]
	readonly spanCount: number
	readonly traceCount: number
}

// Error signals, read off `error.type` (often just the status code),
// `gen_ai.response.status` and the span's own status message. `length` is
// deliberately absent from the context pattern: as a finish reason it means
// max_tokens was reached, which is a normal completion, not a failure.
const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|too.many.requests|resource.exhausted|overloaded/i
const CONTEXT_EXCEEDED_PATTERN =
	/context.{0,16}(length|window|limit)|maximum.context|prompt is too long|too many tokens/i
const REFUSAL_FINISH_REASONS = new Set(["refusal", "content_filter"])

export function buildSessionSummary({
	spans,
	turns,
}: {
	readonly spans: readonly AiSessionSpan[]
	readonly turns: readonly SessionTurn[]
}): SessionSummary {
	// Sorted here so the first-seen orders below (agent names, vendors) are the
	// session's own order rather than the order the warehouse returned rows in.
	const ordered = [...spans].sort((a, b) => spanStartMs(a) - spanStartMs(b))
	const byId = new Map(ordered.map((span) => [span.spanId, span]))

	const startMs = Math.min(...ordered.map(spanStartMs))
	const endMs = Math.max(...ordered.map(spanEndMs))
	const wallClockMs = endMs - startMs

	const idleGaps = findIdleGaps(ordered)
	const idleMs = idleGaps.reduce((total, gap) => total + gap.durationMs, 0)

	const usage = countableUsageSpans(ordered, byId)

	return {
		startMs,
		endMs,
		wallClockMs,
		activeMs: wallClockMs - idleMs,
		idleMs,
		idleGaps,
		occupancy: computeOccupancy(ordered, wallClockMs, idleMs),
		failed: turns[turns.length - 1]?.failed === true,
		title: turns[0]?.label,
		agentNames: distinctInOrder(ordered.map((span) => span.genAi.agentName)),
		vendorIds: distinctInOrder(ordered.map((span) => span.vendorId)),
		serviceNames: byFrequency(ordered.map((span) => span.serviceName)),
		models: modelUsage(ordered, usage.bySpan, costBySpan(ordered, byId)),
		tokens: sumTokens([...usage.bySpan.values()]),
		tokenReporting: classifyTokenReporting(usage, byId, turns),
		cost: sessionCost(ordered, byId),
		work: {
			turns: turns.length,
			llmCalls: ordered.filter(isLlmCall).length,
			toolCalls: ordered.filter((span) => classifyAiSpan(span) === "tool").length,
		},
		failures: countFailures(ordered),
		failureGroups: groupFailures(failureEvents(ordered)),
		tools: toolUsage(ordered),
		spanCount: ordered.length,
		traceCount: new Set(ordered.map((span) => span.traceId)).size,
	}
}

/* -------------------------------------------------------------------------- */
/* Time                                                                       */
/* -------------------------------------------------------------------------- */

interface Interval {
	readonly startMs: number
	readonly endMs: number
}

/** Merge overlapping intervals into a disjoint, ordered cover. */
function union(intervals: readonly Interval[]): Interval[] {
	const sorted = [...intervals]
		.filter((interval) => interval.endMs > interval.startMs)
		.sort((a, b) => a.startMs - b.startMs)
	const merged: Interval[] = []
	for (const interval of sorted) {
		const last = merged[merged.length - 1]
		if (last !== undefined && interval.startMs <= last.endMs) {
			if (interval.endMs > last.endMs) merged[merged.length - 1] = { ...last, endMs: interval.endMs }
		} else {
			merged.push(interval)
		}
	}
	return merged
}

/** `a` minus `b`; both are expected to be disjoint covers. */
function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
	const out: Interval[] = []
	for (const interval of a) {
		let cursor = interval.startMs
		for (const hole of b) {
			if (hole.endMs <= cursor) continue
			if (hole.startMs >= interval.endMs) break
			if (hole.startMs > cursor) out.push({ startMs: cursor, endMs: hole.startMs })
			cursor = Math.max(cursor, hole.endMs)
		}
		if (cursor < interval.endMs) out.push({ startMs: cursor, endMs: interval.endMs })
	}
	return out
}

function totalMs(intervals: readonly Interval[]): number {
	return intervals.reduce((total, interval) => total + (interval.endMs - interval.startMs), 0)
}

/**
 * The stretches where nothing at all was running, long enough to read as the
 * session waiting on a human. Short holes stay in active time — they are the
 * framework's own overhead between spans, and calling a 200ms pause "idle"
 * would scatter the waterfall with meaningless gap rows.
 */
export function findIdleGaps(spans: readonly AiSessionSpan[]): readonly IdleGap[] {
	const busy = union(spans.map((span) => ({ startMs: spanStartMs(span), endMs: spanEndMs(span) })))
	const gaps: IdleGap[] = []
	for (let i = 1; i < busy.length; i++) {
		const startMs = busy[i - 1]!.endMs
		const endMs = busy[i]!.startMs
		const durationMs = endMs - startMs
		if (durationMs > IDLE_GAP_MIN_MS) gaps.push({ id: `gap:${startMs}`, startMs, endMs, durationMs })
	}
	return gaps
}

/**
 * Split the wall clock into disjoint occupancy classes.
 *
 * Overlaps are resolved by a fixed priority — time to first token, then
 * inference, then tool — so the segments always sum to the wall clock. What
 * neither idle nor a gen_ai span accounts for lands in `unaccounted`: agent
 * scaffolding, framework overhead, the app's own spans. That residual is the
 * point of the bar, so it is never folded into a neighbour.
 *
 * Exported so the Overview's per-turn bars split one turn's spans exactly as
 * the session-wide bar above them splits all of them.
 */
export function computeOccupancy(
	spans: readonly AiSessionSpan[],
	wallClockMs: number,
	idleMs: number,
): readonly OccupancySegment[] {
	const ttftIntervals: Interval[] = []
	const inferenceIntervals: Interval[] = []
	const toolIntervals: Interval[] = []

	for (const span of spans) {
		const startMs = spanStartMs(span)
		const endMs = spanEndMs(span)
		const category = classifyAiSpan(span)
		if (category === "tool") {
			toolIntervals.push({ startMs, endMs })
			continue
		}
		if (category !== "inference") continue
		const ttftMs = spanTtftMs(span)
		if (ttftMs === undefined) {
			inferenceIntervals.push({ startMs, endMs })
		} else {
			ttftIntervals.push({ startMs, endMs: startMs + ttftMs })
			inferenceIntervals.push({ startMs: startMs + ttftMs, endMs })
		}
	}

	const ttft = union(ttftIntervals)
	const inference = subtract(union(inferenceIntervals), ttft)
	const tool = subtract(
		union(toolIntervals),
		[...ttft, ...inference].sort((a, b) => a.startMs - b.startMs),
	)

	const ttftMs = totalMs(ttft)
	const inferenceMs = totalMs(inference)
	const toolMs = totalMs(tool)

	return (
		[
			{ kind: "idle", ms: idleMs },
			{ kind: "ttft", ms: ttftMs },
			{ kind: "inference", ms: inferenceMs },
			{ kind: "tool", ms: toolMs },
			{ kind: "unaccounted", ms: wallClockMs - idleMs - ttftMs - inferenceMs - toolMs },
		] as const
	).filter((segment) => segment.ms > 0)
}

/* -------------------------------------------------------------------------- */
/* Tokens, models, cost                                                       */
/* -------------------------------------------------------------------------- */

const EMPTY_TOKENS: SessionTokenTotals = {
	input: 0,
	cacheRead: 0,
	cacheWrite: 0,
	output: 0,
	reasoning: 0,
	total: 0,
}

/** Whether a reporter's `input` bucket already contains its cache buckets. */
type CacheConvention = "inclusive" | "exclusive"

/**
 * `gen_ai.provider.name` → whether that provider's prompt count already
 * CONTAINS the cached tokens reported beside it.
 *
 * Anthropic's Messages API bills the three separately: `input_tokens` excludes
 * both `cache_read_input_tokens` and `cache_creation_input_tokens`, so its
 * total really is the sum of the buckets. Everyone else folds the cache into
 * the prompt figure — OpenAI's `prompt_tokens` contains
 * `prompt_tokens_details.cached_tokens`, Gemini's `promptTokenCount` contains
 * `cachedContentTokenCount`, OpenRouter is OpenAI-shaped — and adding the cache
 * on top of that bills those tokens twice, which on a cache-heavy agent loop is
 * a near-doubling rather than a rounding error.
 *
 * Only providers whose wire shape was checked are listed. Anything else takes
 * the dominant convention, `"inclusive"`: it is what most of the field does,
 * and it errs toward the smaller number rather than inventing tokens.
 */
const PROVIDER_CACHE_CONVENTION = new Map<string, CacheConvention>([
	["anthropic", "exclusive"],
	["openai", "inclusive"],
	["gcp.gemini", "inclusive"],
	["gcp.vertex_ai", "inclusive"],
	["openrouter", "inclusive"],
])

/**
 * Vendors that re-normalise usage before emitting it, whichever provider ran
 * the call — so the vendor, not the provider, decides.
 *
 * The Vercel AI SDK emits `gen_ai.usage.input_tokens` as
 * `result.usage.inputTokens.total`, and its Anthropic provider builds that
 * total as `noCache + cacheRead + cacheWrite`: an Anthropic call made through
 * the SDK is inclusive even though the raw API is not. Verified against the
 * installed packages — `ai/dist/index.mjs` for the attribute and
 * `@ai-sdk/anthropic` (vendored under `eve`) for the sum.
 */
const VENDOR_CACHE_CONVENTION = new Map<string, CacheConvention>([["vercel_ai_sdk", "inclusive"]])

/**
 * True when the span's `input` bucket already covers its cache buckets, so
 * adding them to the total would count the same tokens twice.
 *
 * The vendor is asked first: a framework that re-added the buckets before
 * emitting them has overwritten whatever its provider's own API said.
 */
function cacheInclusiveInput(span: AiSessionSpan): boolean {
	const vendor = VENDOR_CACHE_CONVENTION.get(span.vendorId ?? "")
	const provider = PROVIDER_CACHE_CONVENTION.get(span.genAi.providerName ?? "")
	return (vendor ?? provider ?? "inclusive") === "inclusive"
}

/**
 * The five `gen_ai.usage.*` buckets a span reports and what they total under
 * its provider's convention, or nothing when it reports none. Exported so the
 * waterfall and the flow split a span's usage the same way the header does
 * rather than re-deriving the prompt/completion halves.
 */
export function spanTokenBuckets(span: AiSessionSpan): SessionTokenTotals | undefined {
	const { usageInputTokens, usageCacheReadInputTokens, usageCacheCreationInputTokens } = span.genAi
	const { usageOutputTokens, usageReasoningOutputTokens } = span.genAi
	if (
		usageInputTokens === undefined &&
		usageCacheReadInputTokens === undefined &&
		usageCacheCreationInputTokens === undefined &&
		usageOutputTokens === undefined &&
		usageReasoningOutputTokens === undefined
	) {
		return undefined
	}
	return tokenTotals(
		{
			input: usageInputTokens ?? 0,
			cacheRead: usageCacheReadInputTokens ?? 0,
			cacheWrite: usageCacheCreationInputTokens ?? 0,
			output: usageOutputTokens ?? 0,
			reasoning: usageReasoningOutputTokens ?? 0,
		},
		cacheInclusiveInput(span),
	)
}

/**
 * The five buckets plus what they come to.
 *
 * Under the exclusive convention that is their sum. Under the inclusive one the
 * cache buckets are a *breakdown* of `input`, not tokens beside it, so they
 * stay in the legend — a cache hit rate is worth seeing — and out of the total.
 */
function tokenTotals(
	buckets: Omit<SessionTokenTotals, "total">,
	cacheInclusive: boolean,
): SessionTokenTotals {
	const cached = cacheInclusive ? 0 : buckets.cacheRead + buckets.cacheWrite
	return { ...buckets, total: buckets.input + cached + buckets.output + buckets.reasoning }
}

interface CountableUsage {
	/** Dedup-adjusted usage per reporting span; reporters left with nothing are absent. */
	readonly bySpan: ReadonlyMap<string, SessionTokenTotals>
	/** Some reporter summed usage that a span beneath it also reported. */
	readonly rolledUp: boolean
}

/**
 * Usage per span, with what a deeper span already reported taken off it.
 *
 * Several frameworks stamp `gen_ai.usage.*` on the model span AND sum it onto
 * the agent span that wraps it. Counting the deepest reporter keeps the session
 * total equal to what was actually billed. The wrapper is not dropped outright,
 * though: it keeps whatever it reported ABOVE the sum of the reporters beneath
 * it — zero for a clean roll-up, and the missing call's usage when one of its
 * children reported none.
 */
function countableUsageSpans(
	spans: readonly AiSessionSpan[],
	byId: ReadonlyMap<string, AiSessionSpan>,
): CountableUsage {
	const reported = new Map<string, SessionTokenTotals>()
	for (const span of spans) {
		const tokens = spanTokenBuckets(span)
		if (tokens !== undefined) reported.set(span.spanId, tokens)
	}

	const bySpan = new Map<string, SessionTokenTotals>()
	let rolledUp = false
	for (const [spanId, beneath] of chargeToNearestReporter(byId, reported)) {
		if (beneath.length > 0) rolledUp = true
		// The residual is priced under the PARENT's own convention: it is the
		// parent's figure less its children's, and the parent is what reported it.
		const tokens = excessTokens(
			reported.get(spanId)!,
			sumTokens(beneath),
			cacheInclusiveInput(byId.get(spanId)!),
		)
		if (tokens.total > 0) bySpan.set(spanId, tokens)
	}
	return { bySpan, rolledUp }
}

/**
 * Each reporter charged to the NEAREST ancestor that also reports, so a
 * two-level roll-up subtracts each figure once rather than at every level.
 * Every reporter has an entry; a leaf's list is empty.
 */
function chargeToNearestReporter<T>(
	byId: ReadonlyMap<string, AiSessionSpan>,
	reported: ReadonlyMap<string, T>,
): Map<string, T[]> {
	const claimed = new Map<string, T[]>([...reported.keys()].map((spanId) => [spanId, []]))
	for (const [spanId, value] of reported) {
		const seen = new Set<string>([spanId])
		let parent = byId.get(byId.get(spanId)!.parentSpanId)
		while (parent !== undefined && !seen.has(parent.spanId)) {
			seen.add(parent.spanId)
			if (reported.has(parent.spanId)) {
				claimed.get(parent.spanId)!.push(value)
				break
			}
			parent = byId.get(parent.parentSpanId)
		}
	}
	return claimed
}

/**
 * Reported cost per span under the same deepest-reporter rule as tokens: a
 * wrapper that sums its children's cost onto itself keeps only what it claims
 * above them. Every span that reported a cost has an entry, a fully rolled-up
 * wrapper's being zero — so an empty map means nothing reported at all, which
 * is the difference between "free" and "not measured".
 */
function costBySpan(
	spans: readonly AiSessionSpan[],
	byId: ReadonlyMap<string, AiSessionSpan>,
): ReadonlyMap<string, number> {
	const reported = new Map<string, number>()
	for (const span of spans) {
		const cost = span.genAi.usageCost
		if (cost !== undefined && cost >= 0) reported.set(span.spanId, cost)
	}

	const bySpan = new Map<string, number>()
	for (const [spanId, beneath] of chargeToNearestReporter(byId, reported)) {
		bySpan.set(spanId, Math.max(0, reported.get(spanId)! - beneath.reduce((sum, c) => sum + c, 0)))
	}
	return bySpan
}

function sumCosts(costs: Iterable<number>): number {
	let usd = 0
	for (const cost of costs) usd += cost
	return usd
}

function sessionCost(
	spans: readonly AiSessionSpan[],
	byId: ReadonlyMap<string, AiSessionSpan>,
): number | undefined {
	const bySpan = costBySpan(spans, byId)
	return bySpan.size === 0 ? undefined : sumCosts(bySpan.values())
}

/**
 * One turn's reported spend, by the same rules `countTurnTokens` follows: the
 * deepest reporter counts, and a span reporting for more than this turn counts
 * for none of them.
 */
export function countTurnCost(turn: SessionTurn, turns: readonly SessionTurn[]): number | undefined {
	const byId = new Map(turn.spans.map((span) => [span.spanId, span]))
	const bySpan = [...costBySpan(turn.spans, byId)].filter(
		([spanId]) => !isSessionLevelReporter(byId.get(spanId)!, turns),
	)
	return bySpan.length === 0 ? undefined : sumCosts(bySpan.map(([, cost]) => cost))
}

/** Per bucket, what `reported` claims over `counted`. Never negative: a wrapper
 *  that under-reports its own children adds nothing rather than subtracting. */
function excessTokens(
	reported: SessionTokenTotals,
	counted: SessionTokenTotals,
	cacheInclusive: boolean,
): SessionTokenTotals {
	return tokenTotals(
		{
			input: Math.max(0, reported.input - counted.input),
			cacheRead: Math.max(0, reported.cacheRead - counted.cacheRead),
			cacheWrite: Math.max(0, reported.cacheWrite - counted.cacheWrite),
			output: Math.max(0, reported.output - counted.output),
			reasoning: Math.max(0, reported.reasoning - counted.reasoning),
		},
		cacheInclusive,
	)
}

/**
 * A span that reports usage for more than the turn it started in.
 *
 * Turns are partitioned by time, so a span belongs to the turn its start falls
 * in. A session root — or a long-lived agent span — that reports the whole
 * session's usage would therefore dump all of it into turn 1 and leave every
 * later turn reading zero, which is the one number that is certainly wrong. It
 * counts for the session and for the per-model table, and for no single turn.
 *
 * `turns` is in start order, so the first turn starting after this span is the
 * next one; a reporter that outlives that boundary covers more than one turn.
 */
function isSessionLevelReporter(span: AiSessionSpan, turns: readonly SessionTurn[]): boolean {
	const next = turns.find((turn) => turn.startMs > spanStartMs(span))
	return next !== undefined && spanEndMs(span) > next.startMs
}

/**
 * One turn's tokens, by the same deepest-reporter rule the header counts the
 * session by, less any session-level reporter. The turns therefore add up to
 * the total printed above them whenever the usage was reported per turn, and
 * read as absent rather than as a wrong number when it was not.
 */
export function countTurnTokens(turn: SessionTurn, turns: readonly SessionTurn[]): SessionTokenTotals {
	const byId = new Map(turn.spans.map((span) => [span.spanId, span]))
	const { bySpan } = countableUsageSpans(turn.spans, byId)
	return sumTokens(
		[...bySpan]
			.filter(([spanId]) => !isSessionLevelReporter(byId.get(spanId)!, turns))
			.map(([, tokens]) => tokens),
	)
}

/** Which of the three reporting shapes the session's instrumentation used. */
function classifyTokenReporting(
	usage: CountableUsage,
	byId: ReadonlyMap<string, AiSessionSpan>,
	turns: readonly SessionTurn[],
): SessionTokenReporting {
	const reporters = [...usage.bySpan.keys()]
	if (reporters.length === 0) return "none"
	if (reporters.every((spanId) => isSessionLevelReporter(byId.get(spanId)!, turns))) {
		return "session-level"
	}
	return usage.rolledUp ? "roll-up" : "per-call"
}

function sumTokens(totals: readonly SessionTokenTotals[]): SessionTokenTotals {
	return totals.reduce(
		(sum, tokens) => ({
			input: sum.input + tokens.input,
			cacheRead: sum.cacheRead + tokens.cacheRead,
			cacheWrite: sum.cacheWrite + tokens.cacheWrite,
			output: sum.output + tokens.output,
			reasoning: sum.reasoning + tokens.reasoning,
			total: sum.total + tokens.total,
		}),
		EMPTY_TOKENS,
	)
}

/**
 * Tokens and calls per model, over the model calls alone. A span that reported
 * usage without naming a model gets no row — its tokens are in the session
 * total, which is where a number with no model belongs.
 */
function modelUsage(
	spans: readonly AiSessionSpan[],
	tokensBySpan: ReadonlyMap<string, SessionTokenTotals>,
	costsBySpan: ReadonlyMap<string, number>,
): readonly SessionModelUsage[] {
	const byModel = new Map<string, { llmCalls: number; tokens: SessionTokenTotals[]; costs: number[] }>()

	for (const span of spans) {
		if (!isLlmCall(span)) continue
		const model = spanModel(span)
		if (model === undefined) continue
		let entry = byModel.get(model)
		if (entry === undefined) {
			entry = { llmCalls: 0, tokens: [], costs: [] }
			byModel.set(model, entry)
		}
		entry.llmCalls++
		const tokens = tokensBySpan.get(span.spanId)
		if (tokens !== undefined) entry.tokens.push(tokens)
		const cost = costsBySpan.get(span.spanId)
		if (cost !== undefined) entry.costs.push(cost)
	}

	return [...byModel]
		.map(([model, entry]) => ({
			model,
			llmCalls: entry.llmCalls,
			tokens: sumTokens(entry.tokens),
			// A model whose calls reported no cost reads as unpriced rather than
			// free — the session total may still be non-zero from another model.
			cost: entry.costs.length === 0 ? undefined : sumCosts(entry.costs),
		}))
		.sort((a, b) => b.llmCalls - a.llmCalls || b.tokens.total - a.tokens.total)
}

/**
 * Tools by how often the session called them. Named by `gen_ai.tool.name` where
 * the instrumentation stamped one and by the span name otherwise, so a
 * framework that skips the attribute still gets a histogram rather than
 * disappearing from a column whose total says 63.
 */
function toolUsage(spans: readonly AiSessionSpan[]): readonly SessionToolUsage[] {
	const calls = new Map<string, number>()
	for (const span of spans) {
		if (classifyAiSpan(span) !== "tool") continue
		const name = span.genAi.toolName ?? span.spanName
		calls.set(name, (calls.get(name) ?? 0) + 1)
	}
	return [...calls]
		.map(([name, count]) => ({ name, calls: count }))
		.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
}

/* -------------------------------------------------------------------------- */
/* Work and failures                                                          */
/* -------------------------------------------------------------------------- */

function errorSignal(span: AiSessionSpan): string {
	return [span.genAi.errorType, span.genAi.responseStatus, span.statusMessage]
		.filter((value): value is string => value !== undefined && value !== "")
		.join(" ")
}

/** The error a span reports, or nothing — for a span that did not fail, or one
 *  that failed without saying anything an ancestor could be matched against. */
function failureSignal(span: AiSessionSpan): string | undefined {
	if (span.statusCode !== "Error") return undefined
	const signal = errorSignal(span)
	return signal === "" ? undefined : signal
}

function refusalSignal(span: AiSessionSpan): string | undefined {
	const reasons = (span.genAi.responseFinishReasons ?? [])
		.map((reason) => reason.toLowerCase())
		.filter((reason) => REFUSAL_FINISH_REASONS.has(reason))
	return reasons.length === 0 ? undefined : reasons.join(",")
}

/**
 * Ancestors carrying a signal a span below them already carries.
 *
 * Frameworks stamp the model call's error and its finish reasons on the agent
 * span wrapping it as well. Counted at both levels, one refusal is two and one
 * failure is two — so only the deepest span carrying a given signal counts.
 */
function shadowedAncestorIds(
	spans: readonly AiSessionSpan[],
	signalOf: (span: AiSessionSpan) => string | undefined,
): ReadonlySet<string> {
	const byId = new Map(spans.map((span) => [span.spanId, span]))
	const shadowed = new Set<string>()
	for (const span of spans) {
		const signal = signalOf(span)
		if (signal === undefined) continue
		const seen = new Set<string>([span.spanId])
		let parent = byId.get(span.parentSpanId)
		while (parent !== undefined && !seen.has(parent.spanId)) {
			if (signalOf(parent) === signal) shadowed.add(parent.spanId)
			seen.add(parent.spanId)
			parent = byId.get(parent.parentSpanId)
		}
	}
	return shadowed
}

/**
 * Everything that went wrong, one event per span that went wrong, in start
 * order. First match wins — a tool call that failed with a 429 is one event, a
 * rate limit, because that is the cause worth acting on — and `error` is the
 * catch-all, so every errored span produces an event.
 *
 * Refusals are the exception: they are a finish reason on a span that
 * succeeded, so they are read independently of span status.
 *
 * Both take the deepest reporter, because a framework that copies the model's
 * error or finish reason onto the agent span wrapping it would otherwise report
 * one failure as two.
 *
 * Exported because the counts, the Overview's breakdown and its verdict are
 * three readings of this one list, and they must not disagree.
 */
export function failureEvents(spans: readonly AiSessionSpan[]): readonly SessionFailureEvent[] {
	const shadowedFailures = shadowedAncestorIds(spans, failureSignal)
	const shadowedRefusals = shadowedAncestorIds(spans, refusalSignal)
	const events: SessionFailureEvent[] = []

	for (const span of spans) {
		if (refusalSignal(span) !== undefined && !shadowedRefusals.has(span.spanId)) {
			events.push({ kind: "refusal", label: "refusal", span })
		}
		if (span.statusCode !== "Error" || shadowedFailures.has(span.spanId)) continue
		events.push({ ...classifyFailure(span), span })
	}

	return events
}

function classifyFailure(span: AiSessionSpan): Omit<SessionFailureEvent, "span"> {
	const signal = errorSignal(span)
	if (RATE_LIMIT_PATTERN.test(signal)) return { kind: "rateLimited", label: "rate_limit" }
	if (CONTEXT_EXCEEDED_PATTERN.test(signal)) {
		return { kind: "contextExceeded", label: "context_length_exceeded" }
	}
	// `error.type` is the instrumentation's own word for it; the tool name is
	// what separates one failing tool from another under a shared `tool_error`.
	const name = span.genAi.errorType ?? "error"
	const tool = span.genAi.toolName
	return { kind: "error", label: tool === undefined ? name : `${name} · ${tool}` }
}

function countFailures(spans: readonly AiSessionSpan[]): SessionFailureCounts {
	const counts = { errors: 0, rateLimited: 0, contextExceeded: 0, refusals: 0 }
	for (const event of failureEvents(spans)) {
		if (event.kind === "rateLimited") counts.rateLimited++
		else if (event.kind === "contextExceeded") counts.contextExceeded++
		else if (event.kind === "refusal") counts.refusals++
		else counts.errors++
	}
	return counts
}

/** Events sharing a label, counted, busiest first. */
export function groupFailures(events: readonly SessionFailureEvent[]): readonly SessionFailureGroup[] {
	const groups = new Map<string, SessionFailureGroup>()
	for (const event of events) {
		const existing = groups.get(event.label)
		groups.set(event.label, {
			kind: event.kind,
			label: event.label,
			count: (existing?.count ?? 0) + 1,
		})
	}
	return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/* -------------------------------------------------------------------------- */
/* Small collection helpers                                                   */
/* -------------------------------------------------------------------------- */

function distinctInOrder(values: readonly (string | undefined)[]): readonly string[] {
	const seen: string[] = []
	for (const value of values) {
		if (value !== undefined && value !== "" && !seen.includes(value)) seen.push(value)
	}
	return seen
}

/** Distinct values, busiest first — the header names the dominant service. */
function byFrequency(values: readonly string[]): readonly string[] {
	const counts = new Map<string, number>()
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
	return [...counts].sort((a, b) => b[1] - a[1]).map(([value]) => value)
}
