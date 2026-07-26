/**
 * The Worker, in Alchemy's Effect-native style: one class that is both the
 * resource declaration and the runtime entrypoint (`main: import.meta.filename`).
 *
 * The seam worth looking at is `env` — a `Redacted` output from the Maple
 * provider is a first-class Worker binding, so the credentials the workload
 * needs and the resources that watch it are declared in the same graph.
 */
import * as Maple from "@maple-dev/alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

export const SERVICE_NAME = "checkout"

/** The org's ingest keys — declared once, bound into the Worker below. */
export const IngestKeys = Maple.IngestKeys("ingest")

const hex = (bytes: number): string =>
	Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("")

// OTLP/JSON wants nanosecond timestamps as *strings* — a JSON number loses
// precision past 2^53 and the collector rejects the span.
const nanos = (ms: number): string => `${Math.trunc(ms)}000000`

export default class Api extends Cloudflare.Worker<Api>()(
	"checkout-api",
	{
		main: import.meta.filename,
		compatibility: { date: "2026-04-08", flags: ["nodejs_compat"] },
		url: true,
		env: {
			// Alchemy resolves the resource, ships the value as a Worker secret, and
			// orders the deploy behind it. It stays `Redacted` in the plan output.
			MAPLE_INGEST_KEY: IngestKeys.pipe(Effect.map((keys) => keys.privateKey)),
			MAPLE_ENDPOINT: "https://ingest.maple.dev",
			OTEL_SERVICE_NAME: SERVICE_NAME,
		},
	},
	// Built once per isolate, not per request — so config reads and the HTTP
	// client are set up here, and the handler below stays cheap.
	Effect.gen(function* () {
		const endpoint = yield* Config.string("MAPLE_ENDPOINT")
		const ingestKey = yield* Config.redacted("MAPLE_INGEST_KEY")
		const serviceName = yield* Config.string("OTEL_SERVICE_NAME")
		const client = yield* HttpClient.HttpClient

		const exportSpan = (name: string, startedAt: number, statusCode: number) =>
			client
				.execute(
					HttpClientRequest.post(`${endpoint}/v1/traces`).pipe(
						HttpClientRequest.setHeaders({
							authorization: `Bearer ${Redacted.value(ingestKey)}`,
						}),
						HttpClientRequest.setBody(
							HttpBody.text(
								JSON.stringify({
									resourceSpans: [
										{
											resource: {
												attributes: [
													{
														key: "service.name",
														value: { stringValue: serviceName },
													},
												],
											},
											scopeSpans: [
												{
													scope: { name: "checkout-api" },
													spans: [
														{
															traceId: hex(16),
															spanId: hex(8),
															name,
															kind: 2, // SERVER
															startTimeUnixNano: nanos(startedAt),
															endTimeUnixNano: nanos(Date.now()),
															attributes: [
																{
																	key: "http.response.status_code",
																	value: { intValue: statusCode },
																},
															],
															// OTEL HTTP semconv: only 5xx is an error on a SERVER span.
															status: { code: statusCode >= 500 ? 2 : 1 },
														},
													],
												},
											],
										},
									],
								}),
								"application/json",
							),
						),
					),
				)
				.pipe(Effect.ignore)

		return {
			fetch: Effect.gen(function* () {
				const request = yield* HttpServerRequest
				const ctx = yield* Cloudflare.WorkerExecutionContext
				const startedAt = Date.now()

				const response = yield* HttpServerResponse.json({ ok: true, service: serviceName })

				// Export after the response is sent, so telemetry never adds latency.
				yield* ctx.waitUntil(exportSpan(`${request.method} /`, startedAt, response.status))
				return response
			}),
		}
	}).pipe(Effect.provide(FetchHttpClient.layer)),
) {}
