import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { API_V2_RATE_LIMIT_PARTITION, makeApiV2RateLimitKey } from "./ApiV2RateLimiter"
import { MCP_TOOLS_RATE_LIMIT_BINDING, McpToolRateLimiter } from "./McpToolRateLimiter"

const limiterLayer = (environment: Record<string, unknown>) =>
	McpToolRateLimiter.layer.pipe(Layer.provide(Layer.succeed(WorkerEnvironment, environment)))

describe("McpToolRateLimiter", () => {
	it.effect("counts against its own binding under the stage partition", () => {
		const keys: string[] = []
		const environment = {
			[API_V2_RATE_LIMIT_PARTITION]: "stg",
			[MCP_TOOLS_RATE_LIMIT_BINDING]: {
				limit: ({ key }: { key: string }) => {
					keys.push(key)
					return Promise.resolve({ success: false })
				},
			},
		}

		return Effect.gen(function* () {
			const limiter = yield* McpToolRateLimiter
			expect(yield* limiter.check("key:abc")).toBe("limited")
			expect(keys).toEqual([makeApiV2RateLimitKey("stg", "key:abc")])
		}).pipe(Effect.provide(limiterLayer(environment)))
	})

	it.effect("fails open when only the v2 binding is present", () =>
		Effect.gen(function* () {
			const limiter = yield* McpToolRateLimiter
			expect(yield* limiter.check("key:abc")).toBe("failed_open")
		}).pipe(
			Effect.provide(
				limiterLayer({
					[API_V2_RATE_LIMIT_PARTITION]: "prd",
					API_V2_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
				}),
			),
		),
	)
})
