import { Context, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { InternalScrapeTarget } from "@maple/domain/http"
import { safeFetch, UrlValidationError } from "@maple/safe-fetch"

/**
 * Why the upstream request produced no usable response. `timeout` and
 * `transport` are the target's fault (unreachable, slow, connection reset) and
 * back off like an upstream 5xx; `invalid_url` is a configuration fault — the
 * scrape URL or one of its redirects failed SSRF validation — that no retry
 * cadence will clear.
 */
export const TargetFetchReason = Schema.Literals(["timeout", "transport", "invalid_url"])
export type TargetFetchReason = typeof TargetFetchReason.Type

export class TargetFetchError extends Schema.TaggedError<TargetFetchError>()(
	"@maple/scraper/TargetFetchError",
	{
		message: Schema.String,
		reason: TargetFetchReason,
	},
) {}

export interface TargetResponse {
	/** The target's own HTTP status; a non-2xx is classified by the scheduler. */
	readonly status: number
	readonly body: string
	/** Upstream `Retry-After` in seconds (delta-seconds form), or `null` when absent. */
	readonly retryAfterSeconds: number | null
}

export interface TargetFetcherApi {
	/** GET a target's exposition text from `target.scrapeUrl` with `target.authHeaders`. */
	readonly fetch: (target: InternalScrapeTarget) => Effect.Effect<TargetResponse, TargetFetchError>
}

/**
 * Per-request ceiling. The scrape interval bounds it so one scrape can never
 * overlap the next; the 60s cap keeps a slow upstream (PlanetScale metrics
 * under load) from parking a permit for a whole 300s interval.
 */
export const scrapeTimeoutMs = (scrapeIntervalSeconds: number): number =>
	Math.min(60_000, Math.max(1_000, (scrapeIntervalSeconds - 1) * 1000))

/** Parse a `Retry-After` header value, honoring only the delta-seconds form. */
export const parseRetryAfterSeconds = (value: string | null): number | null => {
	if (value === null) return null
	const seconds = Number(value.trim())
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

const DEFAULT_HEADERS = {
	accept: "application/openmetrics-text;version=1.0.0,text/plain;version=0.0.4;q=0.5,*/*;q=0.1",
	"user-agent": "maple-prometheus-scraper",
} as const

export class TargetFetcher extends Context.Service<TargetFetcher, TargetFetcherApi>()(
	"@maple/scraper/TargetFetcher",
	{
		make: Effect.gen(function* () {
			// `server.address` + `url.path`, never `url.full`: PlanetScale authenticates
			// its metrics data plane with `?sig=&exp=` query params, i.e. credentials.
			// `pathname` drops the query, so the signed URL cannot leak into telemetry.
			//
			// `peer.service` is deliberately low-cardinality (two values, not one per
			// target) — a per-target name would fragment the service map into a node
			// per scrape target.
			const fetchTarget = Effect.fn("scraper.fetch_target", { kind: "client" })(function* (
				target: InternalScrapeTarget,
			) {
				const fetchFn = yield* FetchHttpClient.Fetch
				const parsed = Option.liftThrowable(() => new URL(target.scrapeUrl))()
				// Annotated before the fetch so a failed or timed-out scrape still
				// draws its service-map edge.
				yield* Effect.annotateCurrentSpan({
					"peer.service":
						target.targetType === "planetscale" ? "planetscale-metrics" : "scrape-target",
					"http.request.method": "GET",
					"maple.scrape.target_type": target.targetType,
					...(Option.isSome(parsed)
						? { "server.address": parsed.value.host, "url.path": parsed.value.pathname }
						: undefined),
				})

				// `safeFetch` supplies the SSRF protection + per-hop redirect re-validation
				// the Effect HttpClient transport lacks. The interruption-aware signal from
				// `Effect.tryPromise` plus `Effect.timeout` aborts the in-flight request
				// when the ceiling passes.
				const result = yield* Effect.tryPromise({
					try: async (signal) => {
						const response = await safeFetch(target.scrapeUrl, {
							method: "GET",
							headers: { ...DEFAULT_HEADERS, ...target.authHeaders },
							signal,
							fetchFn,
						})
						return {
							status: response.status,
							body: await response.text(),
							retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")),
						} satisfies TargetResponse
					},
					// Messages are fragments: the scheduler prefixes the target's identity.
					catch: (cause) =>
						cause instanceof UrlValidationError
							? new TargetFetchError({
									message: `url rejected: ${cause.message}`,
									reason: "invalid_url",
								})
							: new TargetFetchError({
									message: `request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
									reason: "transport",
								}),
				}).pipe(
					Effect.timeout(scrapeTimeoutMs(target.scrapeIntervalSeconds)),
					Effect.catchTag("TimeoutError", () =>
						Effect.fail(
							new TargetFetchError({ message: "request timed out", reason: "timeout" }),
						),
					),
				)

				yield* Effect.annotateCurrentSpan({
					"http.response.status_code": result.status,
					// Decoded character count, not wire bytes — hence the vendor
					// namespace rather than `http.response.body.size`.
					"maple.scrape.response_chars": result.body.length,
				})
				return result
			})

			return { fetch: fetchTarget } satisfies TargetFetcherApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
