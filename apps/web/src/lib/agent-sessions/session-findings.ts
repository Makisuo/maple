// The Overview's verdict and findings: discrete claims about what went wrong
// or looked off, each anchored to the span that is its evidence.
//
// Every detector here is a deterministic read of captured spans — grouped
// failures, finish reasons, call counts, holes in the timeline — phrased in the
// instrumentation's own vocabulary. Nothing is scored, sampled or modeled: a
// finding the reader clicks through to must be exactly what the spans say.

import type { AiSessionSpan } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"

import {
	failureEvents,
	findIdleGaps,
	shadowedAncestorIds,
	spanTokenBuckets,
	type SessionFailureKind,
	type SessionSummary,
} from "./session-summary"
import {
	classifyAiSpan,
	isLlmCall,
	spanEndMs,
	spanStartMs,
	type SessionTurn,
} from "./session-turns"

/** Same tool this often within one turn reads as the agent going in circles. */
const REPEATED_TOOL_MIN_CALLS = 8

/**
 * A hole this long INSIDE a turn is the framework stalled mid-flight. Gaps
 * between turns are the user thinking and are never findings — the session-wide
 * `IDLE_GAP_MIN_MS` covers those on the time bar.
 */
const MID_TURN_STALL_MIN_MS = 30_000

/** Finish reasons that mean the reply was cut off at the output token limit. */
const TRUNCATION_FINISH_REASONS = new Set(["length", "max_tokens", "max_output_tokens"])

/** Red or amber: whether the thing found affected the outcome, or merely looks
 *  wrong. The mapping for failures matches the rail's old dot colors — errors
 *  and context blowups red, recovered-shaped rate limits and refusals amber. */
export type FindingSeverity = "failure" | "anomaly"

export interface SessionFinding {
	readonly id: string
	readonly severity: FindingSeverity
	/** The leading token, in the instrumentation's vocabulary where one exists —
	 *  `context_length_exceeded`, `tool_error · run_tests`, `stop length`. */
	readonly label: string
	/** How many spans said it. The row prints ×N above one. */
	readonly count: number
	/** `Turn 14 (final)`, `Turns 9, 11` — where it happened. */
	readonly turnText: string
	/** One line of evidence under the label, when the spans carry any. */
	readonly detail: string | undefined
	/** The span the row opens in the Traces view. */
	readonly spanId: string
	/** First occurrence, for ordering. */
	readonly atMs: number
}

export type SessionVerdictStatus = "failed" | "attention" | "clean"

export interface SessionVerdict {
	readonly status: SessionVerdictStatus
	/** What killed the final turn, when the session failed and a span said. */
	readonly label: string | undefined
	/** The failing span, for the verdict's own link. */
	readonly spanId: string | undefined
}

/** Worst thing the findings attribute to a turn — the shape strip's cell color. */
export type TurnHealth = "clean" | "anomaly" | "failure"

export interface SessionFindingsReport {
	readonly verdict: SessionVerdict
	/** Failures first, the terminal one leading, then anomalies, each in time order. */
	readonly findings: readonly SessionFinding[]
	/** Aligned with `turns`. */
	readonly turnHealth: readonly TurnHealth[]
}

/** A trace-anchored turn is the fallback partition — one turn per trace — so it
 *  is a segment of the session rather than an exchange with the user. */
export function turnOrdinal(turn: SessionTurn): string {
	return `${turn.anchorKind === "trace" ? "Segment" : "Turn"} ${turn.index}`
}

export function buildSessionFindings(
	turns: readonly SessionTurn[],
	summary: SessionSummary,
): SessionFindingsReport {
	const spans = turns
		.flatMap((turn) => turn.spans)
		.sort((a, b) => spanStartMs(a) - spanStartMs(b))
	const turnIndexBySpan = new Map<string, number>()
	turns.forEach((turn, index) => {
		for (const span of turn.spans) turnIndexBySpan.set(span.spanId, index)
	})
	const lastTurnIndex = turns.length - 1
	const events = failureEvents(spans)

	// The LAST failure event in the final turn is the one the turn died on — an
	// earlier rate-limited retry in the same turn is a finding, not the cause.
	const cause = summary.failed
		? events.findLast((event) => turnIndexBySpan.get(event.span.spanId) === lastTurnIndex)
		: undefined

	const findings = [
		...failureFindings(events, turns, turnIndexBySpan, cause?.span.spanId, spans),
		...truncationFindings(spans, turns, turnIndexBySpan),
		...repetitionFindings(turns),
		...stallFindings(turns),
	].sort(
		(a, b) =>
			severityRank(a.severity) - severityRank(b.severity) ||
			// The terminal failure leads: it is the verdict's own evidence.
			Number(b.turnText.endsWith("(final)")) - Number(a.turnText.endsWith("(final)")) ||
			a.atMs - b.atMs,
	)

	const verdict: SessionVerdict = summary.failed
		? { status: "failed", label: cause?.label, spanId: cause?.span.spanId }
		: { status: findings.length > 0 ? "attention" : "clean", label: undefined, spanId: undefined }

	return { verdict, findings, turnHealth: healthOf(turns, findings, turnIndexBySpan) }
}

function severityRank(severity: FindingSeverity): number {
	return severity === "failure" ? 0 : 1
}

/* -------------------------------------------------------------------------- */
/* Detectors                                                                  */
/* -------------------------------------------------------------------------- */

function failureFindings(
	events: ReturnType<typeof failureEvents>,
	turns: readonly SessionTurn[],
	turnIndexBySpan: ReadonlyMap<string, number>,
	/** The span the final turn died on — its group is the terminal finding. */
	causeSpanId: string | undefined,
	spans: readonly AiSessionSpan[],
): SessionFinding[] {
	const byLabel = new Map<
		string,
		{ kind: SessionFailureKind; members: { span: AiSessionSpan; turnIndex: number }[] }
	>()
	for (const event of events) {
		const turnIndex = turnIndexBySpan.get(event.span.spanId) ?? 0
		const group = byLabel.get(event.label) ?? { kind: event.kind, members: [] }
		group.members.push({ span: event.span, turnIndex })
		byLabel.set(event.label, group)
	}

	return [...byLabel].map(([label, group]) => {
		const turnIndices = distinctSorted(group.members.map((member) => member.turnIndex))
		const terminal =
			causeSpanId !== undefined &&
			group.members.some((member) => member.span.spanId === causeSpanId)
		// The terminal group links the span the turn died on; a recovered group
		// links its first event, where the trouble began.
		const linked = terminal
			? group.members.find((member) => member.span.spanId === causeSpanId)!
			: group.members[0]!
		return {
			id: `failure:${label}`,
			// Rate limits and refusals are warnings unless the session died on one:
			// the same split the failure dots have always drawn.
			severity:
				terminal || group.kind === "error" || group.kind === "contextExceeded"
					? ("failure" as const)
					: ("anomaly" as const),
			label,
			count: group.members.length,
			turnText: turnListText(turnIndices, turns, terminal),
			detail:
				(group.kind === "contextExceeded" ? promptGrowth(spans) : undefined) ??
				failureDetail(group.members.map((member) => member.span), label),
			spanId: linked.span.spanId,
			atMs: spanStartMs(group.members[0]!.span),
		}
	})
}

/**
 * The group's evidence line: the first status message a member carries, and
 * where every member is silent, the failed tool call's own recorded result.
 *
 * The fallback exists because frameworks record a failed tool call as a value
 * on an `Ok` span — Maple's own agent stamps `error.type: tool_error` and puts
 * the error message in `gen_ai.tool.call.result`, with no status message at
 * all. For those spans the result payload IS the error.
 */
function failureDetail(spans: readonly AiSessionSpan[], label: string): string | undefined {
	for (const span of spans) {
		const message = span.statusMessage.trim()
		if (message === "" || message === label) continue
		return clipDetail(message)
	}
	for (const span of spans) {
		const result = span.genAi.toolCallResult ?? undefined
		if (result === undefined) continue
		const prose = firstProse(result)
		if (prose !== undefined) return clipDetail(prose)
	}
	return undefined
}

function clipDetail(text: string): string {
	return text.length > 140 ? `${text.slice(0, 139)}…` : text
}

/** Keys an error payload's human message hides under, tried before anything
 *  else so a structured result yields its message rather than its first field. */
const PROSE_KEYS = ["error", "message", "error_message", "errorMessage", "reason", "detail", "text"]

/**
 * The first human-readable line inside a captured payload. Maple's own tool
 * errors are plain strings; other vendors wrap the message in an object or an
 * MCP-style content array, so this walks tolerantly and gives up rather than
 * serialising structure into the row.
 */
function firstProse(value: unknown, depth = 0): string | undefined {
	if (depth > 4) return undefined
	if (typeof value === "string") {
		const line = value
			.split("\n")
			.map((raw) => raw.trim())
			.find((raw) => raw.length > 0)
		return line
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			const prose = firstProse(entry, depth + 1)
			if (prose !== undefined) return prose
		}
		return undefined
	}
	if (typeof value !== "object" || value === null) return undefined
	const record = value as Record<string, unknown>
	for (const key of PROSE_KEYS) {
		if (key in record) {
			const prose = firstProse(record[key], depth + 1)
			if (prose !== undefined) return prose
		}
	}
	// `content` last and on its own: MCP results nest their text parts there.
	return "content" in record ? firstProse(record.content, depth + 1) : undefined
}

/**
 * How the prompt grew over the session's model calls — the story behind a
 * context-window death. Prompt size is the input-side buckets (uncached input
 * plus both cache buckets: what the model actually had in front of it).
 */
function promptGrowth(spans: readonly AiSessionSpan[]): string | undefined {
	const promptSizes = spans
		.filter(isLlmCall)
		.map(spanTokenBuckets)
		.filter((buckets) => buckets !== undefined)
		.map((buckets) => buckets.input + buckets.cacheRead + buckets.cacheWrite)
		.filter((size) => size > 0)
	const first = promptSizes[0]
	const last = promptSizes[promptSizes.length - 1]
	if (first === undefined || last === undefined || promptSizes.length < 2 || last <= first) {
		return undefined
	}
	return `prompt grew ${formatNumber(first)} → ${formatNumber(last)} tokens across the session`
}

function truncationFindings(
	spans: readonly AiSessionSpan[],
	turns: readonly SessionTurn[],
	turnIndexBySpan: ReadonlyMap<string, number>,
): SessionFinding[] {
	const shadowed = shadowedAncestorIds(spans, truncationSignal)
	const members = spans.filter(
		(span) => truncationSignal(span) !== undefined && !shadowed.has(span.spanId),
	)
	if (members.length === 0) return []
	const reason = truncationSignal(members[0]!)!
	return [
		{
			id: "truncation",
			severity: "anomaly",
			// `stop <reason>` is how the transcript's meta line already spells a
			// finish reason, so the finding reads in the same vocabulary.
			label: `stop ${reason}`,
			count: members.length,
			turnText: turnListText(
				distinctSorted(members.map((span) => turnIndexBySpan.get(span.spanId) ?? 0)),
				turns,
				false,
			),
			detail: "the reply hit the output token limit and was cut off",
			spanId: members[0]!.spanId,
			atMs: spanStartMs(members[0]!),
		},
	]
}

function truncationSignal(span: AiSessionSpan): string | undefined {
	const reasons = (span.genAi.responseFinishReasons ?? [])
		.map((reason) => reason.toLowerCase())
		.filter((reason) => TRUNCATION_FINISH_REASONS.has(reason))
	return reasons.length === 0 ? undefined : reasons.join(",")
}

function repetitionFindings(turns: readonly SessionTurn[]): SessionFinding[] {
	const findings: SessionFinding[] = []
	turns.forEach((turn, index) => {
		const byTool = new Map<string, AiSessionSpan[]>()
		for (const span of turn.spans) {
			if (classifyAiSpan(span) !== "tool") continue
			const name = span.genAi.toolName ?? span.spanName
			const list = byTool.get(name) ?? []
			list.push(span)
			byTool.set(name, list)
		}
		for (const [name, calls] of byTool) {
			if (calls.length < REPEATED_TOOL_MIN_CALLS) continue
			findings.push({
				id: `repetition:${turn.id}:${name}`,
				severity: "anomaly",
				label: name,
				count: 1,
				turnText: turnListText([index], turns, false),
				detail: `called ${calls.length}× within one turn`,
				spanId: calls[0]!.spanId,
				atMs: spanStartMs(calls[0]!),
			})
		}
	})
	return findings
}

function stallFindings(turns: readonly SessionTurn[]): SessionFinding[] {
	const findings: SessionFinding[] = []
	turns.forEach((turn, index) => {
		for (const gap of findIdleGaps(turn.spans)) {
			if (gap.durationMs < MID_TURN_STALL_MIN_MS) continue
			// The row links the span the session went quiet after — the closest
			// thing the capture has to what it was stuck on.
			const before = [...turn.spans]
				.filter((span) => spanEndMs(span) <= gap.startMs)
				.sort((a, b) => spanEndMs(b) - spanEndMs(a))[0]
			findings.push({
				id: gap.id,
				severity: "anomaly",
				// The waterfall names its gap rows `idle 4m 20s`; same vocabulary.
				label: `idle ${formatSessionDuration(gap.durationMs)}`,
				count: 1,
				turnText: turnListText([index], turns, false),
				detail: "no span activity mid-turn",
				spanId: before?.spanId ?? turn.anchor.spanId,
				atMs: gap.startMs,
			})
		}
	})
	return findings
}

/* -------------------------------------------------------------------------- */
/* Attribution                                                                */
/* -------------------------------------------------------------------------- */

function healthOf(
	turns: readonly SessionTurn[],
	findings: readonly SessionFinding[],
	turnIndexBySpan: ReadonlyMap<string, number>,
): readonly TurnHealth[] {
	const health = turns.map((turn): TurnHealth => (turn.failed ? "failure" : "clean"))
	for (const finding of findings) {
		const index = turnIndexBySpan.get(finding.spanId)
		if (index === undefined) continue
		if (finding.severity === "failure") health[index] = "failure"
		else if (health[index] === "clean") health[index] = "anomaly"
	}
	return health
}

/** `Turn 4 (final)`, `Turns 9, 11`, `Segments 1, 2`, `6 of 14 turns`. */
function turnListText(
	indices: readonly number[],
	turns: readonly SessionTurn[],
	terminal: boolean,
): string {
	const word = turns[0]?.anchorKind === "trace" ? "Segment" : "Turn"
	if (indices.length === 1) {
		const one = `${word} ${turns[indices[0]!]?.index ?? indices[0]! + 1}`
		return terminal ? `${one} (final)` : one
	}
	if (indices.length > 4) return `${indices.length} of ${turns.length} ${word.toLowerCase()}s`
	const numbers = indices.map((index) => turns[index]?.index ?? index + 1).join(", ")
	return `${word}s ${numbers}${terminal ? " (final)" : ""}`
}

function distinctSorted(values: readonly number[]): readonly number[] {
	return [...new Set(values)].sort((a, b) => a - b)
}
