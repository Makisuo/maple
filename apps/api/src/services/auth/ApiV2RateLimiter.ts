import type { ApiKeyId } from "@maple/domain/http"
import { Context, Effect, Layer, Schema } from "effect"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"

export const API_V2_RATE_LIMIT_BINDING = "API_V2_RATE_LIMITER"
export const API_V2_RATE_LIMIT_PARTITION = "API_V2_RATE_LIMIT_PARTITION"
export const API_V2_RATE_LIMIT_REQUESTS = 600
export const API_V2_RATE_LIMIT_PERIOD_SECONDS = 60

export type RateLimitOutcome = "allowed" | "limited" | "failed_open"

interface RateLimitBinding {
	readonly limit: (options: { readonly key: string }) => Promise<{ readonly success: boolean }>
}

export interface RateLimiterApi {
	/**
	 * Rate-limit one caller-chosen key.
	 *
	 * Takes an opaque string rather than an `ApiKeyId` because the v2 API is no
	 * longer the only caller: the public share surface limits per share token and
	 * per client IP, neither of which is an API key. The `v2:` / `share:` scoping
	 * prefix therefore belongs to the caller — see `makeApiV2RateLimitKey`.
	 */
	readonly check: (key: string) => Effect.Effect<RateLimitOutcome>
}

class RateLimitBindingError extends Schema.TaggedError<RateLimitBindingError>()(
	"@maple/api/services/RateLimitBindingError",
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

export const makeApiV2RateLimitKey = (partition: string, key: string): string => `${partition}:${key}`

/** The v2 API's own scoping prefix, preserving the pre-generalization key shape. */
export const apiV2RateLimitKey = (keyId: ApiKeyId): string => `v2:${keyId}`

/** Share links are limited per token, and separately per client IP. */
export const shareTokenRateLimitKey = (tokenHashPrefix: string): string => `share:${tokenHashPrefix}`
export const shareIpRateLimitKey = (ip: string): string => `shareip:${ip}`

/**
 * Social-preview traffic, bucketed apart from the viewer keys above.
 *
 * The unfurl path is machine traffic — every chat client that sees the link
 * fetches it, and the page worker asks on each document request. Sharing the
 * viewer's bucket would let that crowd rate-limit the humans the link was sent
 * to, which is the failure this separation exists to prevent.
 */
export const shareOgRateLimitKey = (shareKeyPrefix: string): string => `shareog:${shareKeyPrefix}`

export interface RateLimitCheckConfig {
	/** `WorkerEnvironment` name of the Cloudflare rate-limit binding to call. */
	readonly bindingName: string
	/** Span name for the check, e.g. `"ApiV2RateLimiter.check"`. */
	readonly spanName: string
	/** Warn log emitted when the limiter fails open. */
	readonly failOpenMessage: string
}

/**
 * The one fail-open check implementation behind every limiter service: allow /
 * limited from the binding, `failed_open` (with `maple.rate_limit.outcome`
 * telemetry, never a silent pass) when the binding or partition is unavailable.
 */
export const makeRateLimitCheck = (
	environment: Record<string, unknown>,
	config: RateLimitCheckConfig,
): RateLimiterApi["check"] => {
	const warnFailedOpen = (
		reason: "binding_missing" | "partition_missing" | "binding_error",
		cause?: unknown,
	) =>
		Effect.logWarning(config.failOpenMessage).pipe(
			Effect.annotateLogs({
				"maple.rate_limit.outcome": "failed_open",
				"maple.rate_limit.reason": reason,
				...(cause instanceof Error ? { "error.type": cause.name } : undefined),
			}),
		)

	return Effect.fn(config.spanName)(function* (key: string) {
		const binding = environment[config.bindingName]
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
			try: () => binding.limit({ key: makeApiV2RateLimitKey(partition, key) }),
			catch: (cause) =>
				new RateLimitBindingError({
					message: "Cloudflare rate-limit binding call failed",
					cause,
				}),
		}).pipe(
			Effect.map(({ success }) => (success ? ("allowed" as const) : ("limited" as const))),
			Effect.catchTag("@maple/api/services/RateLimitBindingError", (error) =>
				warnFailedOpen("binding_error", error.cause).pipe(Effect.as<RateLimitOutcome>("failed_open")),
			),
		)
	})
}

export class ApiV2RateLimiter extends Context.Service<ApiV2RateLimiter, RateLimiterApi>()(
	"@maple/api/services/ApiV2RateLimiter",
	{
		make: Effect.gen(function* () {
			const environment = yield* WorkerEnvironment
			const check = makeRateLimitCheck(environment, {
				bindingName: API_V2_RATE_LIMIT_BINDING,
				spanName: "ApiV2RateLimiter.check",
				failOpenMessage: "API v2 rate limiter unavailable; allowing request",
			})
			return { check } satisfies RateLimiterApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
