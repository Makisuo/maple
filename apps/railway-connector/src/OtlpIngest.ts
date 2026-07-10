import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { OtlpLogsExportRequest } from "./otlp/logs"
import type { OtlpMetricsExportRequest } from "./otlp/metrics"
import { RailwayConnectorEnv } from "./Env"

export class OtlpIngestError extends Schema.TaggedErrorClass<OtlpIngestError>()(
	"@maple/railway-connector/OtlpIngestError",
	{
		message: Schema.String,
		status: Schema.NullOr(Schema.Number),
	},
) {}

export interface OtlpIngestShape {
	/**
	 * Send an OTLP/JSON logs export through the Maple ingest gateway,
	 * authenticated with the target org's public ingest key — so the data is
	 * metered for billing and routed to the org's warehouse (Tinybird or
	 * self-managed ClickHouse) like any customer OTLP traffic.
	 */
	readonly sendLogs: (
		ingestKey: string,
		request: OtlpLogsExportRequest,
	) => Effect.Effect<void, OtlpIngestError>
	/** Same, for a metrics export. */
	readonly sendMetrics: (
		ingestKey: string,
		request: OtlpMetricsExportRequest,
	) => Effect.Effect<void, OtlpIngestError>
}

export class OtlpIngest extends Context.Service<OtlpIngest, OtlpIngestShape>()(
	"@maple/railway-connector/OtlpIngest",
	{
		make: Effect.gen(function* () {
			const env = yield* RailwayConnectorEnv
			const client = yield* HttpClient.HttpClient

			const send = Effect.fn("OtlpIngest.send")(function* (
				path: "/v1/logs" | "/v1/metrics",
				ingestKey: string,
				request: unknown,
			) {
				const httpRequest = HttpClientRequest.post(`${env.MAPLE_INGEST_URL}${path}`, {
					headers: { authorization: `Bearer ${ingestKey}` },
				}).pipe(HttpClientRequest.bodyText(JSON.stringify(request), "application/json"))

				const response = yield* client.execute(httpRequest).pipe(
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
									? `ingest gateway rejected ${path}: billing limit reached (HTTP 402): ${text.slice(0, 200)}`
									: `ingest gateway returned HTTP ${response.status} for ${path}: ${text.slice(0, 200)}`,
							status: response.status,
						}),
					)
				}
			})

			return {
				sendLogs: (ingestKey, request) => send("/v1/logs", ingestKey, request),
				sendMetrics: (ingestKey, request) => send("/v1/metrics", ingestKey, request),
			} satisfies OtlpIngestShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
