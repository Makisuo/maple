/**
 * The Workers AI shim — the seam that decides whether a model call is keyless and neuron-billed
 * (`env.AI.run`) or a REST request against `api.cloudflare.com` with an API token.
 *
 * That distinction is invisible in types and silent at runtime: when the binding isn't recognised
 * the upstream provider just falls through to REST with `BINDING_PLACEHOLDER` credentials and 401s
 * at the *end* of a turn. Worth pinning, especially since prod attaches an AI Gateway resource
 * while local dev declares a plain `ai` binding.
 */
import { describe, it } from "@effect/vitest"
import { assert } from "vitest"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { isWorkersAiBinding, workersAiHttpClient } from "./WorkersAiHttpClient"

const WORKERS_AI_URL = "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1/chat/completions"
const GATEWAY_URL = "https://gateway.ai.cloudflare.com/v1/abc/maple/compat/chat/completions"

/** A client that records what reached it, standing in for the REST fallback. */
const recordingFallback = () => {
	const seen: Array<string> = []
	const client = HttpClient.make((request) => {
		seen.push(request.url)
		return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("fallback")))
	})
	return { client, seen }
}

const jsonRequest = (url: string, body: unknown) =>
	HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))

describe("isWorkersAiBinding", () => {
	it("recognises a binding by its `run` method", () => {
		assert.isTrue(isWorkersAiBinding({ run: async () => new Response() }))
	})

	it("rejects anything without one", () => {
		// The silent-degradation case: prod binds an AI Gateway resource, and if its shape doesn't
		// satisfy this, every model call quietly becomes an unauthenticated REST call.
		assert.isFalse(isWorkersAiBinding(undefined))
		assert.isFalse(isWorkersAiBinding({}))
		assert.isFalse(isWorkersAiBinding({ run: "not a function" }))
	})
})

describe("workersAiHttpClient", () => {
	it.live("routes a Workers AI chat completion through the binding, hoisting `model`", () =>
		Effect.gen(function* () {
			const calls: Array<{ model: string; inputs: Record<string, unknown> }> = []
			const binding = {
				run: async (model: string, inputs: Record<string, unknown>) => {
					calls.push({ model, inputs })
					return new Response("ok", { status: 200 })
				},
			}
			const { client, seen } = recordingFallback()

			const response = yield* workersAiHttpClient(client, binding).execute(
				jsonRequest(WORKERS_AI_URL, {
					model: "@cf/moonshotai/kimi-k2.6",
					messages: [{ role: "user", content: "hi" }],
					stream: true,
				}),
			)

			assert.equal(response.status, 200)
			assert.isEmpty(seen, "the REST fallback must not see this request")
			assert.lengthOf(calls, 1)
			// `model` is the one field that moves: the binding takes it positionally and the rest of the
			// OpenAI-compatible body passes through untouched.
			assert.equal(calls[0]?.model, "@cf/moonshotai/kimi-k2.6")
			assert.isUndefined(calls[0]?.inputs.model)
			assert.deepEqual(calls[0]?.inputs.messages, [{ role: "user", content: "hi" }])
			assert.equal(calls[0]?.inputs.stream, true)
		}),
	)

	it.live("also matches the AI Gateway compat path", () =>
		Effect.gen(function* () {
			let ran = false
			const binding = {
				run: async () => {
					ran = true
					return new Response("ok")
				},
			}
			const { client } = recordingFallback()

			yield* workersAiHttpClient(client, binding).execute(
				jsonRequest(GATEWAY_URL, { model: "@cf/test", messages: [] }),
			)

			assert.isTrue(ran)
		}),
	)

	it.live("passes non-Workers-AI requests straight through", () =>
		Effect.gen(function* () {
			const binding = {
				run: async () => {
					throw new Error("the binding must not be used for unrelated hosts")
				},
			}
			const { client, seen } = recordingFallback()

			yield* workersAiHttpClient(client, binding).execute(
				jsonRequest("https://api.openai.com/v1/chat/completions", { model: "gpt", messages: [] }),
			)

			assert.deepEqual(seen, ["https://api.openai.com/v1/chat/completions"])
		}),
	)

	it.live("strips Workers AI's native accounting trailer but keeps every OpenAI chunk", () =>
		Effect.gen(function* () {
			// Found end-to-end, not by types: `env.AI.run` streams OpenAI-shaped deltas and then appends
			// one frame of its OWN native accounting, which the upstream provider rejects with
			// "Invalid ... stream event". Because it arrives last, the whole reply streams fine and then
			// the turn dies on the final frame — every chat turn ended in `reason: "error"`.
			const chunk = (payload: string) => `data: ${payload}\n\n`
			const openAiDelta = JSON.stringify({
				choices: [{ delta: { content: "PONG" }, index: 0 }],
				object: "chat.completion.chunk",
			})
			// The `include_usage` chunk also carries `neurons`, so the filter must not eat it: it has
			// `choices` and `object`, which the native trailer does not.
			const usageChunk = JSON.stringify({
				choices: [],
				object: "chat.completion.chunk",
				usage: { prompt_tokens: 10, completion_tokens: 1, neurons: 0.36 },
			})
			const nativeTrailer = JSON.stringify({
				response: "",
				usage: { prompt_tokens: 16804, completion_tokens: 36, neurons: 260.1 },
			})

			const binding = {
				run: async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								const encoder = new TextEncoder()
								controller.enqueue(encoder.encode(chunk(openAiDelta)))
								controller.enqueue(encoder.encode(chunk(usageChunk)))
								controller.enqueue(encoder.encode(chunk("[DONE]")))
								controller.enqueue(encoder.encode(chunk(nativeTrailer)))
								controller.close()
							},
						}),
					),
			}
			const { client } = recordingFallback()

			const response = yield* workersAiHttpClient(client, binding).execute(
				jsonRequest(WORKERS_AI_URL, { model: "@cf/test", messages: [] }),
			)
			const body = yield* response.text

			assert.include(body, openAiDelta, "the content delta passes through")
			assert.include(body, usageChunk, "the OpenAI usage chunk is NOT mistaken for the trailer")
			assert.include(body, "[DONE]", "the terminator passes through")
			assert.notInclude(body, "260.1", "the native trailer is dropped")
		}),
	)

	it("is a no-op without a usable binding", () => {
		const { client } = recordingFallback()
		// Identity, not a wrapper: a stage with no binding still reaches the REST endpoint, so long
		// as a Cloudflare API token is configured.
		assert.strictEqual(workersAiHttpClient(client, undefined), client)
	})

	it.live("fails the request rather than the turn when the binding rejects", () =>
		Effect.gen(function* () {
			const binding = {
				run: async () => {
					throw new Error("neuron budget exhausted")
				},
			}
			const { client } = recordingFallback()

			const exit = yield* Effect.exit(
				workersAiHttpClient(client, binding).execute(
					jsonRequest(WORKERS_AI_URL, { model: "@cf/test", messages: [] }),
				),
			)

			assert.isTrue(exit._tag === "Failure", "a binding error is a typed failure, not a defect")
		}),
	)
})
