// SAFETY-FILE: the SSE bodies here are test fixtures, parsed by the unit under test.
import { describe, it } from "@effect/vitest"
import { assert } from "vitest"
import { Effect, Layer } from "effect"
import type { Tracer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { layerResponseIdentity, modelCallSpan, responseIdentityFromSse } from "./ResponseIdentityHttpClient"

const SSE = [
	": OPENROUTER PROCESSING",
	"",
	'data: {"id":"gen-1","model":"z-ai/glm-5.3-flash","choices":[{"delta":{"content":"Hi"}}]}',
	"",
	'data: {"id":"gen-1","model":"z-ai/glm-5.3-flash","choices":[{"delta":{"content":"!"}}]}',
	"",
	"data: [DONE]",
	"",
].join("\n")

describe("responseIdentityFromSse", () => {
	it("reads the id and model off the first data frame, past comments", () => {
		assert.deepStrictEqual(responseIdentityFromSse(SSE), { id: "gen-1", model: "z-ai/glm-5.3-flash" })
	})

	it("finds nothing in a stream with no complete data frame yet", () => {
		assert.strictEqual(responseIdentityFromSse(": OPENROUTER PROCESSING\n\ndata: {\"id\":\"gen-"), undefined)
		assert.strictEqual(responseIdentityFromSse("data: [DONE]\n"), undefined)
	})

	it("skips a frame naming neither, and stops at one that is not JSON", () => {
		assert.deepStrictEqual(responseIdentityFromSse('data: {"choices":[]}\ndata: {"id":"gen-2"}\n'), {
			id: "gen-2",
		})
		assert.strictEqual(responseIdentityFromSse("data: not json\ndata: {\"id\":\"gen-2\"}\n"), undefined)
	})
})

/** A fetch that answers every request with `body` as an event stream. */
const sseFetch = (body: string): typeof globalThis.fetch => () =>
	Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }))

const jsonFetch: typeof globalThis.fetch = () =>
	Promise.resolve(new Response('{"id":"resp-1"}', { status: 200, headers: { "content-type": "application/json" } }))

const layer = layerResponseIdentity.pipe(Layer.provide(FetchHttpClient.layer))

/** The stack with `fetch` as the transport: `Fetch` is a reference the client
 *  reads off the requesting fiber, so it is provided to the effect, not the layer. */
const withTransport = (fetch: typeof globalThis.fetch) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.provide(layer))

/** Poll until the identity lands: it is stamped from the tee's copy, off the
 *  request's own fiber, so it is a moment behind the served body. Real clock
 *  (`it.live`), because that copy is read by a promise the test clock cannot
 *  advance. */
const stamped = (span: Tracer.Span, key: string) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 50 && !span.attributes.has(key); attempt++) {
			yield* Effect.sleep("2 millis")
		}
		return span.attributes.get(key)
	})

/** A request under a model-call span, as `turn.ts` opens one: returns the span and the body as served. */
const requestUnderModelCall = Effect.gen(function* () {
	const client = yield* HttpClient.HttpClient
	const span = yield* Effect.currentSpan
	const response = yield* client.get("https://openrouter.ai/api/v1/chat/completions")
	const body = yield* response.text
	return { span, body }
}).pipe(Effect.withSpan("chat z-ai/glm-5.3-flash:nitro", { attributes: { "gen_ai.operation.name": "chat" } }))

describe("layerResponseIdentity", () => {
	it.live("stamps the model-call span with the served id and model, and serves the body untouched", () =>
		Effect.gen(function* () {
			const { span, body } = yield* requestUnderModelCall
			assert.strictEqual(body, SSE)
			assert.strictEqual(yield* stamped(span, "gen_ai.response.id"), "gen-1")
			assert.strictEqual(span.attributes.get("gen_ai.response.model"), "z-ai/glm-5.3-flash")
		}).pipe(withTransport(sseFetch(SSE))),
	)

	it.live("reaches the model-call span from a span nested under it", () =>
		Effect.gen(function* () {
			const { span, body } = yield* Effect.withSpan(requestUnderModelCall, "http.client POST")
			assert.strictEqual(body, SSE)
			assert.strictEqual(yield* stamped(span, "gen_ai.response.id"), "gen-1")
		}).pipe(withTransport(sseFetch(SSE))),
	)

	it.live("leaves a response that is not an event stream alone", () =>
		Effect.gen(function* () {
			const { span, body } = yield* requestUnderModelCall
			assert.strictEqual(body, '{"id":"resp-1"}')
			yield* Effect.sleep("10 millis")
			assert.strictEqual(span.attributes.has("gen_ai.response.id"), false)
		}).pipe(withTransport(jsonFetch)),
	)

	it.live("does nothing under a span that is not a model call", () =>
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient
			const span = yield* Effect.currentSpan
			const body = yield* client.get("https://example.test/events").pipe(Effect.flatMap((r) => r.text))
			assert.strictEqual(body, SSE)
			yield* Effect.sleep("10 millis")
			assert.strictEqual(span.attributes.has("gen_ai.response.id"), false)
		}).pipe(
			Effect.withSpan("execute_tool search_traces", { attributes: { "gen_ai.operation.name": "execute_tool" } }),
			withTransport(sseFetch(SSE)),
		),
	)
})

describe("modelCallSpan", () => {
	it.effect("is the nearest ancestor operating a chat, or nothing", () =>
		Effect.gen(function* () {
			const inner = yield* Effect.currentSpan.pipe(
				Effect.withSpan("http.client POST"),
				Effect.withSpan("chat m", { attributes: { "gen_ai.operation.name": "chat" } }),
			)
			assert.strictEqual(modelCallSpan(inner)?.name, "chat m")
			const outer = yield* Effect.currentSpan.pipe(
				Effect.withSpan("http.client POST"),
				Effect.withSpan("invoke_agent a", { attributes: { "gen_ai.operation.name": "invoke_agent" } }),
			)
			assert.strictEqual(modelCallSpan(outer), undefined)
		}),
	)
})
