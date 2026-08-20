// Everything the session header states, derived from the spans.
//
// Two rules shape this module. Time is measured as *occupancy* of the wall
// clock, never as a sum of span durations — a session running four tools in
// parallel would otherwise report 180% of itself. And tokens are counted at the
// deepest span that reports them, because frameworks that also roll usage up to
// the agent span would otherwise double the bill.

import type { AiSessionSpan } from "@maple/domain/http"
import {
	classifySpan,
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
export const IDLE_GAP_MIN_MS = 5_000

/** No span for this long and the session is no longer running. */
export const SESSION_ACTIVE_WINDOW_MS = 30 * 60_000

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
	readonly total: number
}

export interface SessionModelUsage {
	readonly model: string
	readonly llmCalls: number
	readonly tokens: SessionTokenTotals
}

export interface SessionWorkCounts {
	readonly turns: number
	readonly llmCalls: number
	readonly toolCalls: number
	readonly retries: number
}

export interface SessionFailureCounts {
	readonly toolErrors: number
	readonly rateLimited: number
	readonly contextExceeded: number
	readonly refusals: number
}

export type SessionStatus = "active" | "completed" | "failed" | "abandoned"

export interface SessionSummary {
	readonly startMs: number
	readonly endMs: number
	readonly wallClockMs: number
	readonly activeMs: number
	readonly idleMs: number
	readonly idleGaps: readonly IdleGap[]
	/** Non-zero segments only: an unavailable TTFT is absent, never a zero bar. */
	readonly occupancy: readonly OccupancySegment[]
	readonly status: SessionStatus
	/** The opening user message, when content was captured. */
	readonly title: string | undefined
	readonly agentNames: readonly string[]
	readonly vendorIds: readonly string[]
	readonly serviceNames: readonly string[]
	readonly models: readonly SessionModelUsage[]
	readonly tokens: SessionTokenTotals
	readonly work: SessionWorkCounts
	readonly failures: SessionFailureCounts
	readonly spanCount: number
	readonly traceCount: number
}

// Error signals, read off `error.type` (often just the status code),
// `gen_ai.response.status` and the span's own status message. `length` is
// deliberately absent from the context pattern: as a finish reason it means
// max_tokens was reached, which is a normal completion, not a failure.
const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|too.many.requests|resource.exhausted|overloaded/i
const SERVER_ERROR_PATTERN = /\b5\d{2}\b|unavailable|internal.server|bad.gateway|timeout/i
const CONTEXT_EXCEEDED_PATTERN =
	/context.{0,16}(length|window|limit)|maximum.context|prompt is too long|too many tokens/i
const REFUSAL_FINISH_REASONS = new Set(["refusal", "content_filter"])

export function buildSessionSummary(
	spans: readonly AiSessionSpan[],
	turns: readonly SessionTurn[],
	nowMs: number,
): SessionSummary {
	const startMs = Math.min(...spans.map(spanStartMs))
	const endMs = Math.max(...spans.map(spanEndMs))
	const wallClockMs = endMs - startMs

	const idleGaps = findIdleGaps(spans)
	const idleMs = idleGaps.reduce((total, gap) => total + gap.durationMs, 0)

	const tokensBySpan = countableUsageSpans(spans)
	const tokens = sumTokens([...tokensBySpan.values()])

	return {
		startMs,
		endMs,
		wallClockMs,
		activeMs: wallClockMs - idleMs,
		idleMs,
		idleGaps,
		occupancy: computeOccupancy(spans, wallClockMs, idleMs),
		status: sessionStatus(turns, endMs, nowMs),
		title: turns[0]?.label,
		agentNames: distinctInOrder(spans.map((span) => span.genAi.agentName)),
		vendorIds: distinctInOrder(spans.map((span) => span.vendorId)),
		serviceNames: byFrequency(spans.map((span) => span.serviceName)),
		models: modelUsage(spans, tokensBySpan),
		tokens,
		work: {
			turns: turns.length,
			llmCalls: spans.filter(isLlmCall).length,
			toolCalls: spans.filter((span) => classifySpan(span) === "tool").length,
			retries: countRetries(turns),
		},
		failures: countFailures(spans),
		spanCount: spans.length,
		traceCount: new Set(spans.map((span) => span.traceId)).size,
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
 */
function computeOccupancy(
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
		const category = classifySpan(span)
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
	const unaccountedMs = Math.max(0, wallClockMs - idleMs - ttftMs - inferenceMs - toolMs)

	return (
		[
			{ kind: "idle", ms: idleMs },
			{ kind: "ttft", ms: ttftMs },
			{ kind: "inference", ms: inferenceMs },
			{ kind: "tool", ms: toolMs },
			{ kind: "unaccounted", ms: unaccountedMs },
		] as const
	).filter((segment) => segment.ms > 0)
}

function sessionStatus(turns: readonly SessionTurn[], endMs: number, nowMs: number): SessionStatus {
	const lastTurn = turns[turns.length - 1]
	// Failure is checked before the active window: the window measures silence,
	// and a session that errored two minutes ago is silent for a known reason.
	if (lastTurn?.failed === true) return "failed"
	if (nowMs - endMs < SESSION_ACTIVE_WINDOW_MS) return "active"
	if (lastTurn === undefined) return "abandoned"
	// Completion needs positive evidence. Turns recovered from trace boundaries
	// carry none — nothing in the data says the agent finished — so a session
	// that simply stopped reads as abandoned rather than quietly successful.
	return lastTurn.anchorKind === "trace" ? "abandoned" : "completed"
}

/* -------------------------------------------------------------------------- */
/* Tokens, models, spend inputs                                               */
/* -------------------------------------------------------------------------- */

const EMPTY_TOKENS: SessionTokenTotals = {
	input: 0,
	cacheRead: 0,
	cacheWrite: 0,
	output: 0,
	reasoning: 0,
	total: 0,
}

function spanTokens(span: AiSessionSpan): SessionTokenTotals | undefined {
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
	return tokenTotals({
		input: usageInputTokens ?? 0,
		cacheRead: usageCacheReadInputTokens ?? 0,
		cacheWrite: usageCacheCreationInputTokens ?? 0,
		output: usageOutputTokens ?? 0,
		reasoning: usageReasoningOutputTokens ?? 0,
	})
}

/**
 * The five buckets plus the headline total.
 *
 * Cached input is a SUBSET of `gen_ai.usage.input_tokens` under the dominant
 * vendor convention — one production call reports 4935 input against 4932 cache
 * writes — so adding the cache buckets to input nearly doubles the figure the
 * header prints. Where they exceed input they are evidently reported beside it,
 * and the additive total is the honest one. The bucket legend is unaffected
 * either way: it shows what was reported.
 */
function tokenTotals(buckets: Omit<SessionTokenTotals, "total">): SessionTokenTotals {
	const cached = buckets.cacheRead + buckets.cacheWrite
	const total =
		cached <= buckets.input
			? buckets.input + buckets.output + buckets.reasoning
			: buckets.input + cached + buckets.output + buckets.reasoning
	return { ...buckets, total }
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
function countableUsageSpans(spans: readonly AiSessionSpan[]): Map<string, SessionTokenTotals> {
	const byId = new Map(spans.map((span) => [span.spanId, span]))
	const reported = new Map<string, SessionTokenTotals>()
	for (const span of spans) {
		const tokens = spanTokens(span)
		if (tokens !== undefined) reported.set(span.spanId, tokens)
	}

	// Each reporter is charged to the NEAREST ancestor that also reports, so a
	// two-level roll-up subtracts each figure once rather than at every level.
	const claimed = new Map<string, SessionTokenTotals[]>()
	for (const [spanId, tokens] of reported) {
		const seen = new Set<string>([spanId])
		let parent = byId.get(byId.get(spanId)!.parentSpanId)
		while (parent !== undefined && !seen.has(parent.spanId)) {
			seen.add(parent.spanId)
			if (reported.has(parent.spanId)) {
				claimed.set(parent.spanId, [...(claimed.get(parent.spanId) ?? []), tokens])
				break
			}
			parent = byId.get(parent.parentSpanId)
		}
	}

	const countable = new Map<string, SessionTokenTotals>()
	for (const [spanId, tokens] of reported) {
		const beneath = claimed.get(spanId)
		const countableTokens = beneath === undefined ? tokens : excessTokens(tokens, sumTokens(beneath))
		if (countableTokens.total > 0) countable.set(spanId, countableTokens)
	}
	return countable
}

/** Per bucket, what `reported` claims over `counted`. Never negative: a wrapper
 *  that under-reports its own children adds nothing rather than subtracting. */
function excessTokens(reported: SessionTokenTotals, counted: SessionTokenTotals): SessionTokenTotals {
	return tokenTotals({
		input: Math.max(0, reported.input - counted.input),
		cacheRead: Math.max(0, reported.cacheRead - counted.cacheRead),
		cacheWrite: Math.max(0, reported.cacheWrite - counted.cacheWrite),
		output: Math.max(0, reported.output - counted.output),
		reasoning: Math.max(0, reported.reasoning - counted.reasoning),
	})
}

/**
 * The five usage buckets over any set of spans. Exported so the waterfall counts
 * a turn's tokens by the same rule the header counts the session's, and the
 * turns therefore add up to the total printed above them.
 */
export function countSessionTokens(spans: readonly AiSessionSpan[]): SessionTokenTotals {
	return sumTokens([...countableUsageSpans(spans).values()])
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

const UNKNOWN_MODEL = "unknown model"

function modelUsage(
	spans: readonly AiSessionSpan[],
	tokensBySpan: ReadonlyMap<string, SessionTokenTotals>,
): readonly SessionModelUsage[] {
	const byModel = new Map<string, { llmCalls: number; tokens: SessionTokenTotals[] }>()
	const entryFor = (model: string) => {
		const existing = byModel.get(model)
		if (existing !== undefined) return existing
		const created = { llmCalls: 0, tokens: [] as SessionTokenTotals[] }
		byModel.set(model, created)
		return created
	}

	for (const span of spans) {
		const model = spanModel(span) ?? UNKNOWN_MODEL
		if (isLlmCall(span)) entryFor(model).llmCalls++
		const tokens = tokensBySpan.get(span.spanId)
		if (tokens !== undefined) entryFor(model).tokens.push(tokens)
	}

	return [...byModel]
		.map(([model, entry]) => ({ model, llmCalls: entry.llmCalls, tokens: sumTokens(entry.tokens) }))
		.sort((a, b) => b.llmCalls - a.llmCalls || b.tokens.total - a.tokens.total)
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
 * span wrapping it as well. Counted at both levels, one refusal is two, and the
 * outer copy of a failed call becomes a retry that never happened — so only the
 * deepest span carrying a given signal counts.
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
 * The spans counted as retries: errored-then-resent inference.
 *
 * No convention field records "this was attempt 2", so the heuristic is: a model
 * span that failed with a rate limit or a server error, and was followed by
 * another model span in the same turn. It names the failures the agent had to
 * pay for again — the successful attempt is the call, not the retry — and it
 * misses a retry the client swallowed without emitting a span for the failure.
 *
 * Exported as a set of span ids so the waterfall can mark the same spans the
 * header counted, rather than re-deriving the rule beside it.
 */
export function retriedSpanIds(turns: readonly SessionTurn[]): ReadonlySet<string> {
	const shadowed = shadowedAncestorIds(
		turns.flatMap((turn) => [...turn.spans]),
		failureSignal,
	)
	const retried = new Set<string>()
	for (const turn of turns) {
		const llmSpans = turn.spans.filter(isLlmCall)
		for (let i = 0; i < llmSpans.length - 1; i++) {
			const span = llmSpans[i]!
			if (span.statusCode !== "Error" || shadowed.has(span.spanId)) continue
			const signal = errorSignal(span)
			if (RATE_LIMIT_PATTERN.test(signal) || SERVER_ERROR_PATTERN.test(signal)) {
				retried.add(span.spanId)
			}
		}
	}
	return retried
}

function countRetries(turns: readonly SessionTurn[]): number {
	return retriedSpanIds(turns).size
}

/**
 * Errored spans, grouped by why. First match wins — a tool call that failed with
 * a 429 counts once, as rate limiting, because that is the cause worth acting
 * on. An errored span matching none of the three is left out of all of them
 * rather than swelling `tool errors`.
 *
 * Refusals are the exception: they are a finish reason on a span that succeeded,
 * so they are counted independently of span status.
 *
 * Both counts take the deepest reporter, because a framework that copies the
 * model's error or finish reason onto the agent span would otherwise report one
 * failure as two.
 */
function countFailures(spans: readonly AiSessionSpan[]): SessionFailureCounts {
	const shadowedFailures = shadowedAncestorIds(spans, failureSignal)
	const shadowedRefusals = shadowedAncestorIds(spans, refusalSignal)
	let toolErrors = 0
	let rateLimited = 0
	let contextExceeded = 0
	let refusals = 0

	for (const span of spans) {
		if (refusalSignal(span) !== undefined && !shadowedRefusals.has(span.spanId)) refusals++
		if (span.statusCode !== "Error" || shadowedFailures.has(span.spanId)) continue
		const signal = errorSignal(span)
		if (RATE_LIMIT_PATTERN.test(signal)) rateLimited++
		else if (CONTEXT_EXCEEDED_PATTERN.test(signal)) contextExceeded++
		else if (classifySpan(span) === "tool") toolErrors++
	}

	return { toolErrors, rateLimited, contextExceeded, refusals }
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
