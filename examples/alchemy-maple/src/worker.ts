/**
 * The workload half of the example: a Worker that ships one span per request to
 * Maple, authenticated with the ingest key that `alchemy.run.ts` bound into its
 * env. Real apps use an OTel SDK — this is hand-rolled OTLP/JSON to keep the
 * example dependency-free and show exactly what the binding is for.
 */
export interface Env {
	/** `maple_sk_…`, wired from the `Maple.IngestKeys` resource output. */
	MAPLE_INGEST_KEY: string
	MAPLE_ENDPOINT: string
	OTEL_SERVICE_NAME: string
}

const hex = (bytes: number): string =>
	Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("")

// OTLP/JSON wants nanosecond timestamps as *strings* — a JSON number loses
// precision past 2^53 and the collector rejects the span.
const nanos = (ms: number): string => `${Math.trunc(ms)}000000`

const exportSpan = (env: Env, name: string, startedAt: number, statusCode: number): Promise<unknown> =>
	fetch(`${env.MAPLE_ENDPOINT}/v1/traces`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${env.MAPLE_INGEST_KEY}` },
		body: JSON.stringify({
			resourceSpans: [
				{
					resource: {
						attributes: [
							{ key: "service.name", value: { stringValue: env.OTEL_SERVICE_NAME } },
							{ key: "deployment.environment.name", value: { stringValue: "production" } },
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
									attributes: [{ key: "http.response.status_code", value: { intValue: statusCode } }],
									// OTEL HTTP semconv: only 5xx is an error on a SERVER span.
									status: { code: statusCode >= 500 ? 2 : 1 },
								},
							],
						},
					],
				},
			],
		}),
	})

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const startedAt = Date.now()
		const body = JSON.stringify({ ok: true, service: env.OTEL_SERVICE_NAME })
		const response = new Response(body, { headers: { "content-type": "application/json" } })

		// Export after the response is sent so telemetry never adds request latency.
		ctx.waitUntil(exportSpan(env, `${request.method} /`, startedAt, response.status))
		return response
	},
}
