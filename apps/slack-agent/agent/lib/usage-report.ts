/**
 * Per-turn token accumulation for AI usage billing.
 *
 * eve reports usage per model call (`step.completed`), but billing wants one
 * report per turn: a single POST to Maple with a turn-stable idempotency key,
 * instead of a resolve-and-track round trip for every step. So steps
 * accumulate here and `agent/hooks/usage-tracking.ts` flushes on the turn's
 * terminal event (completed, failed, or cancelled — failed turns still
 * consumed the tokens).
 *
 * `inputTokens` is billed as reported: the AI SDK's input count is inclusive
 * of cache reads, matching how the triage flow bills its own usage.
 *
 * TTL-bounded rather than a bare Map: a turn whose terminal event never
 * arrives (process crash mid-flush, eve bug) must not pin its entry for the
 * life of the process. Entries hold two numbers, so the bound is about
 * hygiene, not memory pressure — losing an expired turn's usage is the same
 * accepted loss as a failed fire-and-forget report.
 */
import { createTtlCache } from "./ttl-cache.js"

/** The usage shape eve attaches to `step.completed` (all fields optional). */
export interface StepUsage {
	readonly inputTokens?: number
	readonly outputTokens?: number
}

export interface TurnUsageTotals {
	readonly inputTokens: number
	readonly outputTokens: number
}

/** Far beyond any real turn's duration — this is a leak bound, not a budget. */
const TURN_TTL_MS = 60 * 60_000
const MAX_OPEN_TURNS = 1_000
const SWEEP_INTERVAL_MS = 60_000

interface Entry {
	inputTokens: number
	outputTokens: number
	readonly expiresAt: number
}

const turns = createTtlCache<Entry>({
	maxEntries: MAX_OPEN_TURNS,
	sweepIntervalMs: SWEEP_INTERVAL_MS,
})

/** Adds one step's usage to its turn's running totals. No-ops on empty usage. */
export function addStepUsage(turnId: string, usage: StepUsage | undefined): void {
	const inputTokens = usage?.inputTokens ?? 0
	const outputTokens = usage?.outputTokens ?? 0
	if (inputTokens <= 0 && outputTokens <= 0) return

	const existing = turns.get(turnId)
	if (existing) {
		existing.inputTokens += inputTokens
		existing.outputTokens += outputTokens
		return
	}
	turns.set(turnId, { inputTokens, outputTokens, expiresAt: Date.now() + TURN_TTL_MS })
}

/**
 * Removes and returns the turn's accumulated totals, or null when the turn
 * never accumulated any usage (or already flushed — terminal events can only
 * bill once).
 */
export function takeTurnUsage(turnId: string): TurnUsageTotals | null {
	const entry = turns.get(turnId)
	if (!entry) return null
	turns.delete(turnId)
	return { inputTokens: entry.inputTokens, outputTokens: entry.outputTokens }
}

/** Test-only: drops every accumulating turn so each test starts cold. */
export function resetTurnUsageForTests(): void {
	turns.clear()
}
