/**
 * The retry classifier.
 *
 * The load-bearing case is `Transport` / `InvalidProviderOutput` with `retryable: false` — those
 * are what a mid-stream failure actually looks like, and a classifier that only trusted the
 * `retryable` flag would pass a naive test while doing nothing. See `./retry.ts`.
 */
import { LlmCallError } from "@maple/domain/llm"
import { assert, describe, it } from "vitest"
import { MAX_STEP_ATTEMPTS } from "./budgets"
import { isRetryableStepFailure, stepRetryDelayMs } from "./retry"

const error = (patch: { reason: string; retryable?: boolean; contextOverflow?: boolean }): LlmCallError =>
	new LlmCallError({
		operation: "chat.turn",
		module: "test",
		method: "stream",
		message: "boom",
		reason: patch.reason,
		retryable: patch.retryable ?? false,
		contextOverflow: patch.contextOverflow ?? false,
	})

describe("isRetryableStepFailure", () => {
	it("retries what the provider flags as retryable", () => {
		assert.isTrue(isRetryableStepFailure(error({ reason: "RateLimit", retryable: true })))
		assert.isTrue(isRetryableStepFailure(error({ reason: "ProviderInternal", retryable: true })))
	})

	it("retries stream-level failures despite retryable being false", () => {
		// `TransportReason` and `InvalidProviderOutputReason` both hardcode `retryable = false` in
		// `@opencode-ai/ai`'s error taxonomy, and both are how a body that dies mid-stream surfaces.
		assert.isTrue(isRetryableStepFailure(error({ reason: "Transport" })))
		assert.isTrue(isRetryableStepFailure(error({ reason: "InvalidProviderOutput" })))
	})

	it("does not retry failures that will fail identically", () => {
		assert.isFalse(isRetryableStepFailure(error({ reason: "Authentication" })))
		assert.isFalse(isRetryableStepFailure(error({ reason: "InvalidRequest" })))
		assert.isFalse(isRetryableStepFailure(error({ reason: "QuotaExceeded" })))
		assert.isFalse(isRetryableStepFailure(error({ reason: "ContentPolicy" })))
	})

	it("never retries a context overflow, even when the provider says retryable", () => {
		// The transcript has to shrink first; the same request cannot start fitting.
		assert.isFalse(
			isRetryableStepFailure(
				error({ reason: "InvalidRequest", retryable: true, contextOverflow: true }),
			),
		)
	})
})

describe("stepRetryDelayMs", () => {
	it("backs off exponentially and caps", () => {
		assert.equal(stepRetryDelayMs(0), 1_000)
		assert.equal(stepRetryDelayMs(1), 2_000)
		assert.equal(stepRetryDelayMs(2), 4_000)
		assert.equal(stepRetryDelayMs(3), 8_000)
		assert.equal(stepRetryDelayMs(10), 8_000)
	})

	it("keeps every attempt's backoff under the SSE idle budget", () => {
		// `ChatSession.SUBSCRIBE_IDLE_MS` is 25s; a longer gap would recycle the connection
		// mid-answer.
		for (let attempt = 0; attempt < MAX_STEP_ATTEMPTS; attempt++) {
			assert.isBelow(stepRetryDelayMs(attempt), 25_000)
		}
	})
})
