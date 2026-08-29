import { Context, Effect, Layer } from "effect"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { makeRateLimitCheck, type RateLimiterApi } from "./ApiV2RateLimiter"

export const MCP_TOOLS_RATE_LIMIT_BINDING = "MCP_TOOLS_RATE_LIMITER"
export const MCP_TOOLS_RATE_LIMIT_REQUESTS = 120
export const MCP_TOOLS_RATE_LIMIT_PERIOD_SECONDS = 60

/**
 * Per-credential limiter for the authenticated MCP surface (`POST /mcp`).
 *
 * A dedicated binding rather than `API_V2_RATE_LIMITER` because the budget must
 * differ: MCP tool calls fan out into warehouse queries and LLM calls, so
 * 600/60s per credential is a much larger cost ceiling than it is on `/v2`.
 * Keys arrive pre-scoped by the resolver (`key:<keyId>` / `user:<userId>`) and
 * share the stage partition with the other limiters.
 */
export class McpToolRateLimiter extends Context.Service<McpToolRateLimiter, RateLimiterApi>()(
	"@maple/api/services/McpToolRateLimiter",
	{
		make: Effect.gen(function* () {
			const environment = yield* WorkerEnvironment
			const check = makeRateLimitCheck(environment, {
				bindingName: MCP_TOOLS_RATE_LIMIT_BINDING,
				spanName: "McpToolRateLimiter.check",
				failOpenMessage: "MCP tool rate limiter unavailable; allowing request",
			})
			return { check } satisfies RateLimiterApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
