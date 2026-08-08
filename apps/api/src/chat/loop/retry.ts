/**
 * Which model-call failures a chat step retries, and how long it waits.
 *
 * Pure policy, deliberately separate from the loop that applies it. `./turn.ts` retries a
 * *stream*, so it needs the retraction machinery around the emitted deltas.

 * The ceilings this policy is applied under live in `./budgets.ts`, with every other limit the
 * loop enforces.
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

import { STEP_RETRY_BASE_MS, STEP_RETRY_FACTOR, STEP_RETRY_MAX_MS } from "./budgets"

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
