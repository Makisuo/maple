/**
 * Every ceiling the turn loop enforces, in one place.
 *
 * Collected deliberately. These numbers only make sense against each other — the per-step attempt
 * cap multiplies against the step cap, which multiplies against the sub-agent fan-out, and the
 * product has to stay under `ChatSession`'s `TURN_STALE_MS` watchdog or the Durable Object will
 * declare a *still-running* turn abandoned and write a terminal event underneath it. Scattered
 * across three modules, that relationship was invisible and each constant looked independently
 * reasonable.
 *
 * The worst case, spelled out: `MAX_STEPS` (10) × `TASK_BUDGET_PER_TURN` (4) × `SUBAGENT_MAX_STEPS`
 * (6) = 240 model calls, which `TURN_STEP_BUDGET` (30) is the backstop against.
 */
import { Semaphore } from "effect"

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Hard cap on *tool-calling* assistant turns per submission.
 *
 * A turn that hits it gets one further, tool-less step so the model can answer from what it found,
 * rather than stopping dead on a wall of tool rows with no words.
 */
export const MAX_STEPS = 10

/** Fan-out cap for tool calls issued in the same assistant turn. */
export const TOOL_CONCURRENCY = 4

/**
 * Assistant turns a sub-agent gets.
 *
 * Two-thirds of the parent's budget: enough to search and summarize, not enough to wander. A
 * sub-agent that runs out simply reports what it found, which is a fine answer.
 */
export const SUBAGENT_MAX_STEPS = 6

/**
 * Identical consecutive tool-call batches that mean the model is stuck rather than working.
 *
 * The one ceiling here that is not about *volume*. Every other number bounds how much a productive
 * turn may consume; this one bounds how long an unproductive one may look productive. Three, because
 * two is a plausible retry — a model re-issuing a call after a transient tool failure is behaving
 * correctly — and the third identical batch is the one that says nothing in the results is being
 * read. The policy that applies it is in `./stop.ts`.
 */
export const REPEATED_TOOL_CALLS = 3

/**
 * Model calls across the parent turn and every descendant.
 *
 * The backstop against the multiplication above. If real turns start approaching this, lower
 * `TASK_BUDGET_PER_TURN` — do **not** raise `TURN_STALE_MS` to compensate.
 */
export const TURN_STEP_BUDGET = 30

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/** 1 initial attempt + 3 retries. */
export const MAX_STEP_ATTEMPTS = 4

export const STEP_RETRY_BASE_MS = 1_000
export const STEP_RETRY_FACTOR = 2

/**
 * Ceiling on a single backoff.
 *
 * Bounded well below `ChatSession`'s `SUBSCRIBE_IDLE_MS` (25s), which recycles an SSE connection
 * after that much silence. The `turn-retry` event is itself an append and resets that timer, but a
 * longer gap *after* it would still recycle the connection mid-answer.
 */
export const STEP_RETRY_MAX_MS = 8_000

/**
 * Whole-turn ceiling on time spent in backoff, across every step.
 *
 * opencode retries without an attempt ceiling because it runs in a long-lived process where waiting
 * costs nothing but patience. Here the turn holds the session's single turn slot the entire time.
 */
export const STEP_RETRY_BUDGET_MS = 60_000

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------

/**
 * How deep nesting may go. 1 means the conversation's turn may spawn, and sub-agents may not.
 *
 * Capped twice, as opencode does: structurally, because every sub-agent's ruleset denies `task` so
 * the tool is never offered; and numerically, here. Belt and braces, because the structural cap
 * silently disappears the moment someone writes a sub-agent ruleset with `{"*": allow}`.
 */
export const SUBAGENT_MAX_DEPTH = 1

/** Concurrent sub-agent turns inside one Durable Object. */
export const TASK_CONCURRENCY = 2

/** Total sub-agent turns one parent turn may start, across all its steps. */
export const TASK_BUDGET_PER_TURN = 4

// ---------------------------------------------------------------------------
// The mutable records
// ---------------------------------------------------------------------------

/**
 * Time already spent in backoff this turn.
 *
 * Mutable and shared rather than returned, the same shape and for the same reason as `TurnUsage`:
 * the consumer is mid-turn, so there is no "after the turn" moment to reconcile at. A per-step cap
 * would compose badly — ten steps each retrying three times is minutes of pure backoff.
 */
export interface StepRetryBudget {
	spentMs: number
}

export const makeStepRetryBudget = (): StepRetryBudget => ({ spentMs: 0 })

/** Delegation state, shared by the parent turn and every descendant. */
export interface TaskBudget {
	tasksStarted: number
	stepsUsed: number
	readonly semaphore: Semaphore.Semaphore
}

export const makeTaskBudget = (): TaskBudget => ({
	tasksStarted: 0,
	stepsUsed: 0,
	semaphore: Semaphore.makeUnsafe(TASK_CONCURRENCY),
})

/** Whether the turn may make another model call at all. Checked by the loop and by `delegate`. */
export const hasStepBudget = (budget: TaskBudget | undefined): boolean =>
	budget === undefined || budget.stepsUsed < TURN_STEP_BUDGET
