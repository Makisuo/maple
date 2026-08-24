// The Overview's turn-by-turn digest: one row per turn, derived from the spans
// the debug views read.
//
// Every number in a row is the turn's own, counted by the same
// deepest-reporter rules the session totals use — so a row reads "—" where a
// session-level reporter claimed the usage for no single turn, and that
// difference is information rather than a bug.

import {
	computeOccupancy,
	countTurnCost,
	countTurnTokens,
	failureEvents,
	findIdleGaps,
	groupFailures,
	type OccupancySegment,
	type SessionFailureGroup,
	type SessionTokenTotals,
} from "./session-summary"
import { classifyAiSpan, isLlmCall, spanModel, type SessionTurn } from "./session-turns"

/** Models called in one turn, busiest first. */
export interface TurnModelUsage {
	readonly model: string
	readonly calls: number
}

export interface TurnToolUsage {
	readonly name: string
	readonly calls: number
}

/** One row of the turn-by-turn digest. */
export interface TurnDigest {
	readonly turn: SessionTurn
	/** `Turn 4`, or `Segment 4` where turns fell back to one per trace. */
	readonly ordinal: string
	readonly models: readonly TurnModelUsage[]
	readonly tools: readonly TurnToolUsage[]
	/** What went wrong inside this turn, grouped. Empty for a clean turn. */
	readonly failures: readonly SessionFailureGroup[]
	/** The turn's own wall clock, split the way the session bar splits the whole. */
	readonly occupancy: readonly OccupancySegment[]
	readonly tokens: SessionTokenTotals
	/** Reported spend for this turn, or nothing when no span in it reported any. */
	readonly cost: number | undefined
}

export function buildTurnDigest(turns: readonly SessionTurn[]): readonly TurnDigest[] {
	return turns.map((turn) => ({
		turn,
		ordinal: turnOrdinal(turn),
		models: turnModels(turn),
		tools: turnTools(turn),
		failures: groupFailures(failureEvents(turn.spans)),
		// The turn's own idle: a hole inside a turn is the framework waiting on
		// something, and leaving it out would make the bar claim work that wasn't
		// running.
		occupancy: computeOccupancy(turn.spans, turn.durationMs, idleMsOf(turn)),
		tokens: countTurnTokens(turn, turns),
		cost: countTurnCost(turn, turns),
	}))
}

/** A trace-anchored turn is the fallback partition — one turn per trace — so it
 *  is a segment of the session rather than an exchange with the user. */
export function turnOrdinal(turn: SessionTurn): string {
	return `${turn.anchorKind === "trace" ? "Segment" : "Turn"} ${turn.index}`
}

function idleMsOf(turn: SessionTurn): number {
	return findIdleGaps(turn.spans).reduce((total, gap) => total + gap.durationMs, 0)
}

function turnModels(turn: SessionTurn): readonly TurnModelUsage[] {
	const calls = new Map<string, number>()
	for (const span of turn.spans) {
		if (!isLlmCall(span)) continue
		const model = spanModel(span)
		if (model === undefined) continue
		calls.set(model, (calls.get(model) ?? 0) + 1)
	}
	return [...calls].map(([model, count]) => ({ model, calls: count })).sort(byCallsDesc)
}

function turnTools(turn: SessionTurn): readonly TurnToolUsage[] {
	const calls = new Map<string, number>()
	for (const span of turn.spans) {
		if (classifyAiSpan(span) !== "tool") continue
		const name = span.genAi.toolName ?? span.spanName
		calls.set(name, (calls.get(name) ?? 0) + 1)
	}
	return [...calls].map(([name, count]) => ({ name, calls: count })).sort(byCallsDesc)
}

function byCallsDesc(a: { calls: number }, b: { calls: number }): number {
	return b.calls - a.calls
}
