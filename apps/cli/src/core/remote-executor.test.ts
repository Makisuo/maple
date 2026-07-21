import { describe, it } from "@effect/vitest"
import { strict as assert } from "node:assert"
import { Effect, Tracer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { WarehouseUpstreamError } from "@maple/domain/http/warehouse-errors"
import { makeRemoteWarehouseExecutorShape } from "./remote-executor"

const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

describe("remote warehouse executor", () => {
	it.effect("preserves canonical warehouse error tags from the API", () =>
		Effect.gen(function* () {
			const upstream = new WarehouseUpstreamError({
				message: "warehouse unavailable",
				pipeName: "list_services",
				upstreamStatus: 503,
			})
			const fetchStub = (async () =>
				new Response(JSON.stringify(upstream), {
					status: 503,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch
			const error = yield* Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient
				const shape = makeRemoteWarehouseExecutorShape(
					client,
					"https://api.maple.dev",
					"test-token",
					"org_test",
				)
				return yield* Effect.flip(shape.query("get_service_usage", {}))
			}).pipe(
				Effect.provide(FetchHttpClient.layer),
				Effect.provideService(FetchHttpClient.Fetch, fetchStub),
			)

			assert.ok(error instanceof WarehouseUpstreamError)
			assert.strictEqual(error.upstreamStatus, 503)
		}),
	)

	it.effect("attributes the HTTP peer without inventing a database system", () =>
		Effect.gen(function* () {
			const fetchStub = (async () =>
				new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch
			const { spans, tracer } = makeRecordingTracer()
			yield* Effect.gen(function* () {
				const client = yield* HttpClient.HttpClient
				const shape = makeRemoteWarehouseExecutorShape(
					client,
					"https://api.maple.dev",
					"test-token",
					"org_test",
				)
				yield* shape
					.query("get_service_usage", {}, { context: "remoteServices", profile: "list" })
					.pipe(Effect.withTracer(tracer))
			}).pipe(
				Effect.provide(FetchHttpClient.layer),
				Effect.provideService(FetchHttpClient.Fetch, fetchStub),
			)

			const span = spans.find((candidate) => candidate.name === "warehouse.query")
			assert.ok(span)
			assert.strictEqual(span.kind, "client")
			assert.strictEqual(span.attributes.get("peer.service"), "maple-api")
			assert.strictEqual(span.attributes.get("db.system.name"), undefined)
			assert.strictEqual(span.attributes.get("http.request.method"), "POST")
			assert.strictEqual(span.attributes.get("query.context"), "remoteServices")
		}),
	)
})
