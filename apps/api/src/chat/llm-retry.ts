/**
 * Which model-call failures a chat step retries, and how long it waits.
 *
 * Pure policy, deliberately separate from the loop that applies it: `apps/api/src/chat/agent.ts`
 * retries a *stream*, so it needs the retraction machinery in `runStepAttempt`, while
 * `apps/api/src/workflows/triage-agent.ts` retries an `Effect` and can use `Effect.retry`
 * directly. The classification must not diverge between them, so it lives here.
 *
 * ## Why this cannot just read `LlmCallError.retryable`
 *
 * `lib/llm`'s `RequestExecutor` already retries — twice, capped at 10s — but it wraps
 * `executeOnce`, which resolves when *response headers* arrive. It cannot replay a stream that
 * died at token 400. That mid-stream case is the entire reason this module exists.
 *
 * And a mid-stream failure does not report itself as retryable. `route/client.ts`'s stream-level
 * `Stream.catchCause` surfaces it as either `Transport` (the fetch body died) or
 * `InvalidProviderOutput` (framing or decoding blew up), and both of those reasons hardcode
 * `get retryable() { return false }` in `lib/llm/src/schema/errors.ts`. A classifier that trusted
 * the flag would retry only what the executor already retried — it would look correct, pass a
 * naive test, and do nothing.
 */
import type { LlmCallError } from "@maple/domain/llm"

/** 1 initial attempt + 3 retries. */
export const MAX_STEP_ATTEMPTS = 4

const STEP_RETRY_BASE_MS = 1_000
const STEP_RETRY_FACTOR = 2

/**
 * Ceiling on a single backoff.
 *
 * Bounded well below `ChatSession`'s `SUBSCRIBE_IDLE_MS` (25s), which recycles an SSE connection
 * after that much silence. The `turn-retry` event is itself an append and resets that timer, but a
 * longer gap *after* it would still recycle the connection mid-answer.
 */
const STEP_RETRY_MAX_MS = 8_000

/**
 * Whole-turn ceiling on time spent in backoff, across every step.
 *
 * opencode retries without an attempt ceiling because it runs in a long-lived process where waiting
 * costs nothing but patience. Here the turn holds `ChatSession`'s single turn slot, and
 * `TURN_STALE_MS` (15 minutes) will declare it abandoned and append a terminal event *underneath* a
 * still-running turn. With `MAX_STEPS = 10`, an uncapped per-step retry multiplies past that.
 */
export const STEP_RETRY_BUDGET_MS = 60_000

/** Mutable, shared across a turn's steps — the same pattern as `TurnUsage`, for the same reason. */
export interface StepRetryBudget {
	spentMs: number
}

export const makeStepRetryBudget = (): StepRetryBudget => ({ spentMs: 0 })

/**
 * Reasons the vendored executor cannot cover, because they arrive after response headers.
 *
 * `InvalidProviderOutput` is the debatable inclusion: genuinely malformed provider output will fail
 * identically on every attempt and burn the whole budget. It is here because an interrupted body
 * also lands on it — `route/client.ts`'s `streamError` only looks for a `Fail` reason and falls
 * through to `eventError` otherwise — and `MAX_STEP_ATTEMPTS` bounds the waste to a few seconds.
 * Narrow this to `Transport` alone if it proves noisy in practice.
 */
const STREAM_LEVEL_REASONS: ReadonlySet<string> = new Set(["Transport", "InvalidProviderOutput"])

export const isRetryableStepFailure = (error: LlmCallError): boolean => {
	// Never retried as-is: the request is too big, and sending it again cannot change that. The
	// caller shrinks the transcript and retries the *pruned* request instead.
	if (error.contextOverflow) return false
	// `RateLimit` and `ProviderInternal` — the latter already covers 5xx.
	if (error.retryable) return true
	return STREAM_LEVEL_REASONS.has(error.reason)
}

export const stepRetryDelayMs = (attempt: number): number =>
	Math.min(STEP_RETRY_BASE_MS * STEP_RETRY_FACTOR ** attempt, STEP_RETRY_MAX_MS)
