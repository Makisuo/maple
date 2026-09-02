import { Context, Duration, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { countDataPoints, splitExportRequest, type OtlpExportRequest } from "./prometheus/otlp"
import { ScraperEnv } from "./Env"

export class OtlpIngestError extends Schema.TaggedError<OtlpIngestError>()("@maple/scraper/OtlpIngestError", {
	message: Schema.String,
	status: Schema.NullOr(Schema.Number),
}) {}

export interface OtlpIngestApi {
	/**
	 * Send an OTLP/JSON metrics export through the Maple ingest gateway,
	 * authenticated with the target org's public ingest key — so the data is
	 * metered for billing and routed to the org's warehouse (Tinybird or
	 * self-managed ClickHouse) like any customer OTLP traffic.
	 *
	 * An export larger than `SCRAPER_OTLP_MAX_DATA_POINTS` is split across
	 * several POSTs. Delivery stops at the first rejected chunk and the
	 * rejection is raised, so earlier chunks stay delivered rather than a whole
	 * scrape being lost to one oversized body.
	 */
	readonly send: (ingestKey: string, request: OtlpExportRequest) => Effect.Effect<void, OtlpIngestError>
}

export class OtlpIngest extends Context.Service<OtlpIngest, OtlpIngestApi>()("@maple/scraper/OtlpIngest", {
	make: Effect.gen(function* () {
		const env = yield* ScraperEnv
		const client = yield* HttpClient.HttpClient

		// Bound every chunk round-trip, like ApiClient does: `FetchHttpClient`
		// sets no timeout, and each scrape holds a global concurrency permit
		// through delivery — a gateway that accepts connections but never
		// answers would otherwise pin permits until SCRAPER_CONCURRENCY stalled
		// sends halt every target, with /health still reporting ok. A timeout
		// fails the chunk as a retryable OtlpIngestError instead.
		const REQUEST_TIMEOUT = Duration.seconds(30)

		/**
		 * Resolves to `null` on success, or to the error for a rejection the span
		 * must NOT be blamed for. Carrying a 4xx out of the span as a *value* is
		 * what keeps `OtlpIngest.send` from closing as `Error`: a 402 (org over
		 * its billing limit) or any other client-side rejection is expected and
		 * gets annotated, matching the repo's rule that only 5xx is `Error`. The
		 * typed `OtlpIngestError` still reaches the caller either way, so
		 * `ScrapeScheduler` can classify it as `delivery_blocked`.
		 */
		const attempt = (ingestKey: string, request: OtlpExportRequest) =>
			Effect.gen(function* () {
				const httpRequest = HttpClientRequest.post(`${env.MAPLE_INGEST_URL}/v1/metrics`, {
					headers: { authorization: `Bearer ${ingestKey}` },
				}).pipe(HttpClientRequest.bodyText(JSON.stringify(request), "application/json"))

				const response = yield* client.execute(httpRequest).pipe(
					Effect.annotateSpans("peer.service", "ingest"),
					Effect.timeout(REQUEST_TIMEOUT),
					Effect.mapError(
						(error) =>
							new OtlpIngestError({
								message: `ingest gateway unreachable: ${error.message}`,
								status: null,
							}),
					),
				)
				if (response.status < 200 || response.status >= 300) {
					// The body read is bounded too — a stalled response stream after
					// the status line would otherwise hang past the request timeout.
					const text = yield* response.text.pipe(
						Effect.timeout(REQUEST_TIMEOUT),
						Effect.orElseSucceed(() => ""),
					)
					const error = new OtlpIngestError({
						message:
							response.status === 402
								? `ingest gateway rejected metrics: billing limit reached (HTTP 402): ${text.slice(0, 200)}`
								: `ingest gateway returned HTTP ${response.status}: ${text.slice(0, 200)}`,
						status: response.status,
					})
					yield* Effect.annotateCurrentSpan("http.response.status_code", response.status)
					if (response.status >= 400 && response.status < 500) {
						yield* Effect.annotateCurrentSpan(
							"error.type",
							response.status === 402 ? "delivery_blocked" : `ingest_http_${response.status}`,
						)
						return error
					}
					return yield* Effect.fail(error)
				}
				return null
			})

		/**
		 * Deliver every chunk in order, stopping at the first rejection and
		 * carrying it out as a value — same reason as {@link attempt}: a 4xx must
		 * annotate this span, not fail it. A 5xx still fails inside `attempt` and
		 * propagates, so the span closes `Error` for a genuine gateway fault.
		 */
		const deliver = (ingestKey: string, chunks: ReadonlyArray<OtlpExportRequest>) =>
			Effect.gen(function* () {
				for (let index = 0; index < chunks.length; index++) {
					const rejection = yield* attempt(ingestKey, chunks[index]!).pipe(
						Effect.withSpan("OtlpIngest.send_chunk", {
							attributes: {
								"maple.otlp.chunk_index": index,
								"maple.otlp.chunk_count": chunks.length,
							},
						}),
					)
					if (rejection !== null) {
						yield* Effect.annotateCurrentSpan({
							"maple.otlp.chunks_delivered": index,
							"http.response.status_code": rejection.status,
							"error.type":
								rejection.status === 402
									? "delivery_blocked"
									: `ingest_http_${rejection.status}`,
						})
						return rejection
					}
				}
				yield* Effect.annotateCurrentSpan("maple.otlp.chunks_delivered", chunks.length)
				return null
			})

		const send = (ingestKey: string, request: OtlpExportRequest) =>
			Effect.gen(function* () {
				const chunks = splitExportRequest(request, env.SCRAPER_OTLP_MAX_DATA_POINTS)
				yield* Effect.annotateCurrentSpan({
					"maple.otlp.data_points": countDataPoints(request),
					"maple.otlp.chunk_count": chunks.length,
				})
				return yield* deliver(ingestKey, chunks)
			}).pipe(
				// One `withSpan` only — pairing it with `Effect.fn` of the same name
				// would emit two spans per send.
				Effect.withSpan("OtlpIngest.send"),
				// Fail *outside* the span so an annotated 4xx doesn't set its status.
				Effect.flatMap((rejection) => (rejection === null ? Effect.void : Effect.fail(rejection))),
			)

		return { send } satisfies OtlpIngestApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
