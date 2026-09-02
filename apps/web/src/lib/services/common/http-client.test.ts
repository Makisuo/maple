import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Result } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http"

import { withRequestTimeout } from "./http-client"

const NEVER_RESPONDS: typeof globalThis.fetch = () => new Promise<Response>(() => {})

const get = (fetchStub: typeof globalThis.fetch) =>
	Effect.gen(function* () {
		const client = withRequestTimeout(yield* HttpClient.HttpClient)
		return yield* client.get("https://api.test/anything")
	}).pipe(
		Effect.provide(FetchHttpClient.layer),
		Effect.provideService(FetchHttpClient.Fetch, fetchStub),
	)

/**
 * The deadline used to live in the fetch implementation as
 * `signal: init?.signal ?? AbortSignal.timeout(…)`. `FetchHttpClient` always
 * supplies its own signal, so that branch never ran and a stalled request stayed
 * pending forever.
 */
describe("withRequestTimeout", () => {
	it.effect("fails a request that never responds, rather than hanging", () =>
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(Effect.result(get(NEVER_RESPONDS)))

			yield* TestClock.adjust("44 seconds")
			assert.isUndefined(fiber.pollUnsafe(), "gave up before the deadline")

			yield* TestClock.adjust("1 second")
			const result = yield* Fiber.join(fiber)
			assert.isTrue(Result.isFailure(result), "request outlived the deadline")
			assert.instanceOf(
				Result.isFailure(result) ? result.failure : undefined,
				HttpClientError.HttpClientError,
			)
		}),
	)

	it.effect("leaves a responding request alone", () =>
		Effect.gen(function* () {
			const response = yield* get(async () => new Response("{}", { status: 200 }))

			assert.strictEqual(response.status, 200)
		}),
	)
})
