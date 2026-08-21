import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { OtlpExportRequest } from "./prometheus/otlp"
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
	 */
	readonly send: (ingestKey: string, request: OtlpExportRequest) => Effect.Effect<void, OtlpIngestError>
}

export class OtlpIngest extends Context.Service<OtlpIngest, OtlpIngestApi>()("@maple/scraper/OtlpIngest", {
	make: Effect.gen(function* () {
		const env = yield* ScraperEnv
		const client = yield* HttpClient.HttpClient

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
					Effect.mapError(
						(error) =>
							new OtlpIngestError({
								message: `ingest gateway unreachable: ${error.message}`,
								status: null,
							}),
					),
				)
				if (response.status < 200 || response.status >= 300) {
					const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
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

		const send = (ingestKey: string, request: OtlpExportRequest) =>
			attempt(ingestKey, request).pipe(
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
