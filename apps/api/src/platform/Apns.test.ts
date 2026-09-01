import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeSingleFlightTokenCache } from "./Apns"

describe("makeSingleFlightTokenCache", () => {
	it.live("many concurrent reads on a cold cache mint exactly once", () =>
		Effect.gen(function* () {
			let mints = 0
			// The mint suspends (as the real ECDSA sign does), so without
			// single-flight every concurrent fiber would observe the empty cache
			// and mint its own token.
			const mint = Effect.gen(function* () {
				mints += 1
				yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))
				return `token-${mints}`
			})
			const currentToken = yield* makeSingleFlightTokenCache(60_000, mint)
			const tokens = yield* Effect.all(
				Array.from({ length: 8 }, () => currentToken),
				{ concurrency: "unbounded" },
			)
			assert.strictEqual(mints, 1)
			assert.deepStrictEqual(
				tokens,
				Array.from({ length: 8 }, () => "token-1"),
			)
		}),
	)

	it.live("mints again only after the TTL expires", () =>
		Effect.gen(function* () {
			let mints = 0
			const mint = Effect.sync(() => {
				mints += 1
				return `token-${mints}`
			})
			const currentToken = yield* makeSingleFlightTokenCache(10, mint)
			assert.strictEqual(yield* currentToken, "token-1")
			assert.strictEqual(yield* currentToken, "token-1")
			yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 15)))
			assert.strictEqual(yield* currentToken, "token-2")
			assert.strictEqual(mints, 2)
		}),
	)
})
