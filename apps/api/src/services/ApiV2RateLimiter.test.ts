import { describe, expect, it } from "@effect/vitest"
import { ApiKeyId } from "@maple/domain/http"
import { Effect, Layer, Schema } from "effect"
import { WorkerEnvironment } from "../lib/WorkerEnvironment"
import {
	API_V2_RATE_LIMIT_BINDING,
	API_V2_RATE_LIMIT_PARTITION,
	ApiV2RateLimiter,
	makeApiV2RateLimitKey,
} from "./ApiV2RateLimiter"

const KEY_A = Schema.decodeUnknownSync(ApiKeyId)("00000000-0000-4000-8000-000000000001")
const KEY_B = Schema.decodeUnknownSync(ApiKeyId)("00000000-0000-4000-8000-000000000002")

const limiterLayer = (environment: Record<string, unknown>) =>
	ApiV2RateLimiter.layer.pipe(Layer.provide(Layer.succeed(WorkerEnvironment, environment)))

describe("ApiV2RateLimiter", () => {
	it.effect("uses only the stage partition and internal API-key ID as the counter key", () => {
		const keys: string[] = []
		const environment = {
			[API_V2_RATE_LIMIT_PARTITION]: "stg",
			[API_V2_RATE_LIMIT_BINDING]: {
				limit: ({ key }: { key: string }) => {
					keys.push(key)
					return Promise.resolve({ success: true })
				},
			},
		}

		return Effect.gen(function* () {
			const limiter = yield* ApiV2RateLimiter
			expect(yield* limiter.check(KEY_A)).toBe("allowed")
			expect(yield* limiter.check(KEY_B)).toBe("allowed")
			expect(keys).toEqual([makeApiV2RateLimitKey("stg", KEY_A), makeApiV2RateLimitKey("stg", KEY_B)])
			expect(keys.join(" ")).not.toContain("maple_ak_")
		}).pipe(Effect.provide(limiterLayer(environment)))
	})

	it.effect("isolates the same key across deployment stages", () => {
		const observed: string[] = []
		const binding = {
			limit: ({ key }: { key: string }) => {
				observed.push(key)
				return Promise.resolve({ success: true })
			},
		}
		const run = (partition: string) =>
			Effect.gen(function* () {
				const limiter = yield* ApiV2RateLimiter
				return yield* limiter.check(KEY_A)
			}).pipe(
				Effect.provide(
					limiterLayer({
						[API_V2_RATE_LIMIT_PARTITION]: partition,
						[API_V2_RATE_LIMIT_BINDING]: binding,
					}),
				),
			)

		return Effect.gen(function* () {
			expect(yield* run("prd")).toBe("allowed")
			expect(yield* run("stg")).toBe("allowed")
			expect(observed).toEqual([
				makeApiV2RateLimitKey("prd", KEY_A),
				makeApiV2RateLimitKey("stg", KEY_A),
			])
		})
	})

	it.effect("returns limited when Cloudflare denies the key", () =>
		Effect.gen(function* () {
			const limiter = yield* ApiV2RateLimiter
			expect(yield* limiter.check(KEY_A)).toBe("limited")
		}).pipe(
			Effect.provide(
				limiterLayer({
					[API_V2_RATE_LIMIT_PARTITION]: "prd",
					[API_V2_RATE_LIMIT_BINDING]: {
						limit: () => Promise.resolve({ success: false }),
					},
				}),
			),
		),
	)

	it.effect("fails open when the binding or partition is unavailable", () => {
		const run = (environment: Record<string, unknown>) =>
			Effect.gen(function* () {
				const limiter = yield* ApiV2RateLimiter
				return yield* limiter.check(KEY_A)
			}).pipe(Effect.provide(limiterLayer(environment)))

		return Effect.gen(function* () {
			expect(yield* run({ [API_V2_RATE_LIMIT_PARTITION]: "prd" })).toBe("failed_open")
			expect(
				yield* run({
					[API_V2_RATE_LIMIT_BINDING]: { limit: () => Promise.resolve({ success: true }) },
				}),
			).toBe("failed_open")
		})
	})

	it.effect("fails open when the Cloudflare binding throws", () =>
		Effect.gen(function* () {
			const limiter = yield* ApiV2RateLimiter
			expect(yield* limiter.check(KEY_A)).toBe("failed_open")
		}).pipe(
			Effect.provide(
				limiterLayer({
					[API_V2_RATE_LIMIT_PARTITION]: "prd",
					[API_V2_RATE_LIMIT_BINDING]: {
						limit: () => Promise.reject(new Error("binding unavailable")),
					},
				}),
			),
		),
	)
})
