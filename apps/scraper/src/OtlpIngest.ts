import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { OtlpExportRequest } from "./prometheus/otlp"
import { ScraperEnv } from "./Env"

export class OtlpIngestError extends Schema.TaggedError<OtlpIngestError>()("@maple/scraper/OtlpIngestError", {
	message: Schema.String,
	status: Schema.NullOr(Schema.Number),
}) {}

export interface OtlpIngestShape {
	/**
	 * Send an OTLP/JSON metrics export through the Maple ingest gateway,
	 * authenticated with the target org's public ingest key — so the data is
	 * metered for billing and routed to the org's warehouse (Tinybird or
	 * self-managed ClickHouse) like any customer OTLP traffic.
	 */
	readonly send: (ingestKey: string, request: OtlpExportRequest) => Effect.Effect<void, OtlpIngestError>
}

export class OtlpIngest extends Context.Service<OtlpIngest, OtlpIngestShape>()("@maple/scraper/OtlpIngest", {
	make: Effect.gen(function* () {
		const env = yield* ScraperEnv
		const client = yield* HttpClient.HttpClient

		const send = Effect.fn("OtlpIngest.send")(function* (ingestKey: string, request: OtlpExportRequest) {
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
				return yield* Effect.fail(
					new OtlpIngestError({
						message:
							response.status === 402
								? `ingest gateway rejected metrics: billing limit reached (HTTP 402): ${text.slice(0, 200)}`
								: `ingest gateway returned HTTP ${response.status}: ${text.slice(0, 200)}`,
						status: response.status,
					}),
				)
			}
		})

		return { send } satisfies OtlpIngestShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
