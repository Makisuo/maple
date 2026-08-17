import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpIngest } from "./OtlpIngest"
import { ScraperEnv, type ScraperEnvConfig } from "./Env"
import type { OtlpExportRequest } from "./prometheus/otlp"

const testEnv: ScraperEnvConfig = {
	MAPLE_API_URL: "http://api.test",
	SD_INTERNAL_TOKEN: Redacted.make("internal-token"),
	MAPLE_INGEST_URL: "http://ingest.test",
	SCRAPER_CONCURRENCY: 10,
	SCRAPER_RECONCILE_INTERVAL_SECONDS: 60,
	PORT: 0,
}

const TestLayer = OtlpIngest.layer.pipe(
	Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(ScraperEnv, testEnv))),
)

const SAMPLE_REQUEST: OtlpExportRequest = {
	resourceMetrics: [
		{
			resource: { attributes: [{ key: "service.name", value: { stringValue: "node" } }] },
			scopeMetrics: [
				{
					scope: { name: "maple-prometheus-scraper" },
					metrics: [
						{
							name: "up",
							description: "",
							unit: "",
							gauge: {
								dataPoints: [
									{
										attributes: [],
										startTimeUnixNano: "0",
										timeUnixNano: "1750000000000000000",
										asDouble: 1,
									},
								],
							},
						},
					],
				},
			],
		},
	],
}

interface RecordedRequest {
	url: string
	method: string
	headers: Record<string, string>
	body: string | null
}

const stubFetch = (recorded: Array<RecordedRequest>, respond: () => Response): typeof globalThis.fetch =>
	(async (input: string | URL | Request, init?: RequestInit) => {
		const headers: Record<string, string> = {}
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value
		})
		recorded.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers,
			body:
				typeof init?.body === "string"
					? init.body
					: init?.body instanceof Uint8Array
						? new TextDecoder().decode(init.body)
						: null,
		})
		return respond()
	}) as typeof globalThis.fetch

describe("OtlpIngest", () => {
	it.effect("posts OTLP JSON to the gateway with the org's ingest key", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const otlp = yield* OtlpIngest
			yield* otlp.send("maple_pk_test_key", SAMPLE_REQUEST).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(recorded, () => Response.json({ partialSuccess: {} })),
				),
			)

			assert.strictEqual(recorded[0]?.url, "http://ingest.test/v1/metrics")
			assert.strictEqual(recorded[0]?.method, "POST")
			assert.strictEqual(recorded[0]?.headers.authorization, "Bearer maple_pk_test_key")
			assert.strictEqual(recorded[0]?.headers["content-type"], "application/json")
			assert.deepStrictEqual(JSON.parse(recorded[0]?.body ?? "{}"), SAMPLE_REQUEST)
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("surfaces a billing-limit rejection (402) as a typed error", () =>
		Effect.gen(function* () {
			const otlp = yield* OtlpIngest
			const error = yield* otlp.send("maple_pk_test_key", SAMPLE_REQUEST).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch([], () => new Response("metrics limit reached", { status: 402 })),
				),
				Effect.flip,
			)
			assert.strictEqual(error._tag, "@maple/scraper/OtlpIngestError")
			assert.strictEqual(error.status, 402)
			assert.include(error.message, "billing limit")
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("fails with a typed error on other non-2xx responses", () =>
		Effect.gen(function* () {
			const otlp = yield* OtlpIngest
			const error = yield* otlp.send("maple_pk_test_key", SAMPLE_REQUEST).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch([], () => new Response("nope", { status: 401 })),
				),
				Effect.flip,
			)
			assert.strictEqual(error.status, 401)
		}).pipe(Effect.provide(TestLayer)),
	)
})
