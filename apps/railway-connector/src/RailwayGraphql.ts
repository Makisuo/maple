/**
 * HTTP executor for Railway's public GraphQL API with rate-limit accounting.
 *
 * Railway rate-limits by the CUSTOMER's plan (100 requests/hour free, 1,000
 * hobby, 10,000 pro) and the plan is not queryable, so the poller reads the
 * `X-RateLimit-Remaining` / `Retry-After` response headers and stretches poll
 * delays when the budget runs low instead of assuming a tier.
 */
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { RailwayConnectorEnv } from "./Env"

export class RailwayRequestError extends Schema.TaggedErrorClass<RailwayRequestError>()(
	"@maple/railway-connector/RailwayRequestError",
	{
		message: Schema.String,
		status: Schema.NullOr(Schema.Number),
		unauthorized: Schema.Boolean,
		rateLimited: Schema.Boolean,
		retryAfterMs: Schema.NullOr(Schema.Number),
	},
) {}

export interface RailwayRateInfo {
	/** Requests left in the current window per `X-RateLimit-Remaining`; null when absent. */
	readonly remaining: number | null
}

export interface RailwayGraphqlResult {
	readonly data: unknown
	readonly rate: RailwayRateInfo
}

/** Below this many remaining requests the pollers stretch their delays. */
export const RATE_LOW_WATER = 25
/** Upper bound on backoff so a target keeps probing for recovery. */
export const MAX_BACKOFF_MS = Duration.toMillis(Duration.minutes(15))

/**
 * The delay before a target's next metrics poll. The happy path returns the
 * configured interval; a rate-limited attempt escalates exponentially —
 * honoring `Retry-After` when longer — and a low remaining budget stretches
 * the interval 4× so many services on one token stay inside the hourly
 * window. Capped at {@link MAX_BACKOFF_MS}.
 */
export const nextPollDelayMs = ({
	baseMs,
	rateLimited,
	retryAfterMs,
	remaining,
	consecutiveRateLimits,
}: {
	readonly baseMs: number
	readonly rateLimited: boolean
	readonly retryAfterMs: number | null
	readonly remaining: number | null
	readonly consecutiveRateLimits: number
}): number => {
	if (rateLimited) {
		const exponential = baseMs * 2 ** (consecutiveRateLimits + 1)
		return Math.min(MAX_BACKOFF_MS, Math.max(exponential, retryAfterMs ?? 0))
	}
	if (remaining !== null && remaining < RATE_LOW_WATER) {
		return Math.min(MAX_BACKOFF_MS, baseMs * 4)
	}
	return baseMs
}

const parseRemaining = (value: string | undefined): number | null => {
	if (value === undefined) return null
	const parsed = Number(value.trim())
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

const parseRetryAfterMs = (value: string | undefined): number | null => {
	if (value === undefined) return null
	const seconds = Number(value.trim())
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null
}

const graphqlErrorMessages = (errors: unknown): string | null => {
	if (!Array.isArray(errors) || errors.length === 0) return null
	const messages = errors
		.map((error) =>
			typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
				? ((error as { message: string }).message)
				: null,
		)
		.filter((message): message is string => message !== null)
	return messages.length > 0 ? messages.join("; ") : "Railway API returned GraphQL errors"
}

const isUnauthorizedMessage = (message: string): boolean => /not authorized|unauthorized/i.test(message)

export interface RailwayGraphqlShape {
	/**
	 * POST one GraphQL operation with the target's Railway token. GraphQL-level
	 * errors surface as `RailwayRequestError` (auth-shaped messages flagged
	 * `unauthorized`); HTTP 429 surfaces `rateLimited` with `Retry-After`.
	 */
	readonly query: (
		token: string,
		request: { readonly query: string; readonly variables?: Record<string, unknown> },
	) => Effect.Effect<RailwayGraphqlResult, RailwayRequestError>
}

export class RailwayGraphql extends Context.Service<RailwayGraphql, RailwayGraphqlShape>()(
	"@maple/railway-connector/RailwayGraphql",
	{
		make: Effect.gen(function* () {
			const env = yield* RailwayConnectorEnv
			const client = yield* HttpClient.HttpClient

			const REQUEST_TIMEOUT = Duration.seconds(30)

			const query = Effect.fn("RailwayGraphql.query")(function* (
				token: string,
				request: { readonly query: string; readonly variables?: Record<string, unknown> },
			) {
				const httpRequest = HttpClientRequest.post(env.RAILWAY_GRAPHQL_HTTP_URL, {
					headers: { authorization: `Bearer ${token}` },
				}).pipe(
					HttpClientRequest.bodyText(
						JSON.stringify({
							query: request.query,
							...(request.variables === undefined ? {} : { variables: request.variables }),
						}),
						"application/json",
					),
				)

				const response = yield* client.execute(httpRequest).pipe(
					Effect.timeout(REQUEST_TIMEOUT),
					Effect.mapError(
						(error) =>
							new RailwayRequestError({
								message: `Railway API unreachable: ${error.message}`,
								status: null,
								unauthorized: false,
								rateLimited: false,
								retryAfterMs: null,
							}),
					),
				)

				const rate: RailwayRateInfo = {
					remaining: parseRemaining(response.headers["x-ratelimit-remaining"]),
				}

				if (response.status === 429) {
					return yield* Effect.fail(
						new RailwayRequestError({
							message: "Railway API rate limit reached",
							status: 429,
							unauthorized: false,
							rateLimited: true,
							retryAfterMs: parseRetryAfterMs(response.headers["retry-after"]),
						}),
					)
				}
				if (response.status === 401 || response.status === 403) {
					return yield* Effect.fail(
						new RailwayRequestError({
							message: "Railway rejected the API token",
							status: response.status,
							unauthorized: true,
							rateLimited: false,
							retryAfterMs: null,
						}),
					)
				}

				const text = yield* response.text.pipe(
					Effect.mapError(
						(error) =>
							new RailwayRequestError({
								message: `Railway API response unreadable: ${error.message}`,
								status: response.status,
								unauthorized: false,
								rateLimited: false,
								retryAfterMs: null,
							}),
					),
				)

				if (response.status >= 400) {
					return yield* Effect.fail(
						new RailwayRequestError({
							message: `Railway API returned HTTP ${response.status}: ${text.slice(0, 200)}`,
							status: response.status,
							unauthorized: false,
							rateLimited: false,
							retryAfterMs: null,
						}),
					)
				}

				const parsed = yield* Effect.try({
					try: () => JSON.parse(text) as { data?: unknown; errors?: unknown },
					catch: () =>
						new RailwayRequestError({
							message: "Railway API returned invalid JSON",
							status: response.status,
							unauthorized: false,
							rateLimited: false,
							retryAfterMs: null,
						}),
				})

				const errorMessage = graphqlErrorMessages(parsed.errors)
				if (errorMessage !== null) {
					return yield* Effect.fail(
						new RailwayRequestError({
							message: errorMessage,
							status: response.status,
							unauthorized: isUnauthorizedMessage(errorMessage),
							rateLimited: false,
							retryAfterMs: null,
						}),
					)
				}

				return { data: parsed.data ?? null, rate } satisfies RailwayGraphqlResult
			})

			return { query } satisfies RailwayGraphqlShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
