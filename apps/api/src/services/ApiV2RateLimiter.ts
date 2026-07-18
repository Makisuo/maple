import type { ApiKeyId } from "@maple/domain/http"
import { Context, Effect, Layer, Schema } from "effect"
import { WorkerEnvironment } from "../lib/WorkerEnvironment"

export const API_V2_RATE_LIMIT_BINDING = "API_V2_RATE_LIMITER"
export const API_V2_RATE_LIMIT_PARTITION = "API_V2_RATE_LIMIT_PARTITION"
export const API_V2_RATE_LIMIT_REQUESTS = 600
export const API_V2_RATE_LIMIT_PERIOD_SECONDS = 60

export type ApiV2RateLimitOutcome = "allowed" | "limited" | "failed_open"

interface RateLimitBinding {
	readonly limit: (options: { readonly key: string }) => Promise<{ readonly success: boolean }>
}

export interface ApiV2RateLimiterShape {
	readonly check: (keyId: ApiKeyId) => Effect.Effect<ApiV2RateLimitOutcome>
}

class ApiV2RateLimiterBindingError extends Schema.TaggedErrorClass<ApiV2RateLimiterBindingError>()(
	"@maple/api/services/ApiV2RateLimiterBindingError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

const isRateLimitBinding = (value: unknown): value is RateLimitBinding =>
	typeof value === "object" &&
	value !== null &&
	"limit" in value &&
	typeof (value as { readonly limit?: unknown }).limit === "function"

const readPartition = (environment: Record<string, unknown>): string | undefined => {
	const value = environment[API_V2_RATE_LIMIT_PARTITION]
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

export const makeApiV2RateLimitKey = (partition: string, keyId: ApiKeyId): string =>
	`${partition}:v2:${keyId}`

const warnFailedOpen = (reason: "binding_missing" | "partition_missing" | "binding_error", cause?: unknown) =>
	Effect.logWarning("API v2 rate limiter unavailable; allowing request").pipe(
		Effect.annotateLogs({
			"maple.rate_limit.outcome": "failed_open",
			"maple.rate_limit.reason": reason,
			...(cause instanceof Error ? { "error.type": cause.name } : {}),
		}),
	)

export class ApiV2RateLimiter extends Context.Service<ApiV2RateLimiter, ApiV2RateLimiterShape>()(
	"@maple/api/services/ApiV2RateLimiter",
	{
		make: Effect.gen(function* () {
			const environment = yield* WorkerEnvironment

			const check = Effect.fn("ApiV2RateLimiter.check")(function* (keyId: ApiKeyId) {
				const binding = environment[API_V2_RATE_LIMIT_BINDING]
				if (!isRateLimitBinding(binding)) {
					yield* warnFailedOpen("binding_missing")
					return "failed_open" as const
				}

				const partition = readPartition(environment)
				if (partition === undefined) {
					yield* warnFailedOpen("partition_missing")
					return "failed_open" as const
				}

				return yield* Effect.tryPromise({
					try: () => binding.limit({ key: makeApiV2RateLimitKey(partition, keyId) }),
					catch: (cause) =>
						new ApiV2RateLimiterBindingError({
							message: "Cloudflare rate-limit binding call failed",
							cause,
						}),
				}).pipe(
					Effect.map(({ success }) => (success ? ("allowed" as const) : ("limited" as const))),
					Effect.catchTag("@maple/api/services/ApiV2RateLimiterBindingError", (error) =>
						warnFailedOpen("binding_error", error.cause).pipe(
							Effect.as<ApiV2RateLimitOutcome>("failed_open"),
						),
					),
				)
			})

			return { check } satisfies ApiV2RateLimiterShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
