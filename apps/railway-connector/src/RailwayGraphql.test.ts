import { assert, describe, it } from "@effect/vitest"
import { MAX_BACKOFF_MS, nextPollDelayMs, RATE_LOW_WATER } from "./RailwayGraphql"

const BASE = 300_000

describe("nextPollDelayMs", () => {
	it("returns the base interval on the happy path", () => {
		assert.strictEqual(
			nextPollDelayMs({
				baseMs: BASE,
				rateLimited: false,
				retryAfterMs: null,
				remaining: 500,
				consecutiveRateLimits: 0,
			}),
			BASE,
		)
	})

	it("stretches the interval when the remaining budget runs low", () => {
		assert.strictEqual(
			nextPollDelayMs({
				baseMs: 60_000,
				rateLimited: false,
				retryAfterMs: null,
				remaining: RATE_LOW_WATER - 1,
				consecutiveRateLimits: 0,
			}),
			240_000,
		)
		// The stretch still respects the global backoff cap.
		assert.strictEqual(
			nextPollDelayMs({
				baseMs: BASE,
				rateLimited: false,
				retryAfterMs: null,
				remaining: RATE_LOW_WATER - 1,
				consecutiveRateLimits: 0,
			}),
			MAX_BACKOFF_MS,
		)
		// A missing header is not treated as low budget.
		assert.strictEqual(
			nextPollDelayMs({
				baseMs: BASE,
				rateLimited: false,
				retryAfterMs: null,
				remaining: null,
				consecutiveRateLimits: 0,
			}),
			BASE,
		)
	})

	it("escalates exponentially on consecutive rate limits, honoring Retry-After", () => {
		const first = nextPollDelayMs({
			baseMs: 60_000,
			rateLimited: true,
			retryAfterMs: null,
			remaining: 0,
			consecutiveRateLimits: 0,
		})
		assert.strictEqual(first, 120_000)

		const second = nextPollDelayMs({
			baseMs: 60_000,
			rateLimited: true,
			retryAfterMs: null,
			remaining: 0,
			consecutiveRateLimits: 1,
		})
		assert.strictEqual(second, 240_000)

		// Retry-After wins when longer than the exponential step.
		assert.strictEqual(
			nextPollDelayMs({
				baseMs: 60_000,
				rateLimited: true,
				retryAfterMs: 600_000,
				remaining: 0,
				consecutiveRateLimits: 0,
			}),
			600_000,
		)
	})

	it("caps backoff at MAX_BACKOFF_MS", () => {
		assert.strictEqual(
			nextPollDelayMs({
				baseMs: 300_000,
				rateLimited: true,
				retryAfterMs: 3_600_000,
				remaining: 0,
				consecutiveRateLimits: 10,
			}),
			MAX_BACKOFF_MS,
		)
	})
})
