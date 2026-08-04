/**
 * Wire-level proof that OpenRouter calls are attributed and tagged.
 *
 * `LLMClient.prepare` is deliberately not used here: it returns the *protocol* body, which is built
 * before `http.body` is overlaid onto it, so it cannot see the tags at all. The only place the tags
 * and the attribution headers exist together is the outgoing HTTP request — so the test swaps
 * `FetchHttpClient.Fetch` for a capture and reads what would have gone over the wire.
 *
 * The fake responds 400, which `@maple/llm` classifies as non-retryable. That keeps the run to a
 * single request with no backoff; the resulting failure is expected and ignored.
 */
import { LLM } from "@maple/llm"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { layerLlm, resolveTriageModel, type LlmCallTags, type LlmEnv } from "./Llm"

interface CapturedRequest {
	readonly url: string
	readonly headers: Record<string, string>
	readonly body: Record<string, unknown>
}

/**
 * Run one `LLM.generate` against a fetch that records the request instead of sending it.
 */
const captureRequest = async (env: LlmEnv, tags?: LlmCallTags): Promise<CapturedRequest> => {
	let captured: CapturedRequest | undefined

	const fakeFetch: typeof globalThis.fetch = async (input, init) => {
		const headers: Record<string, string> = {}
		new Headers(init?.headers).forEach((value, key) => {
			headers[key.toLowerCase()] = value
		})
		// The body arrives as bytes, not a string — `Response` is the cheapest correct decoder.
		const bodyText = await new Response(init?.body ?? "{}").text()
		captured = {
			url: String(input),
			headers,
			body: JSON.parse(bodyText) as Record<string, unknown>,
		}
		return new Response(JSON.stringify({ error: "captured" }), { status: 400 })
	}

	const request = LLM.request({
		model: resolveTriageModel(env, tags),
		system: "You are concise.",
		prompt: "hi",
	})

	await Effect.runPromise(
		LLM.generate(request).pipe(
			Effect.ignore,
			Effect.provide(
				layerLlm(env).pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fakeFetch))),
			),
		),
	)

	if (captured === undefined) throw new Error("no request reached the transport")
	return captured
}

const openRouterEnv: LlmEnv = { OPENROUTER_API_KEY: "test-key" }

const tags: LlmCallTags = { surface: "chat", orgId: "org_123", sessionId: "chat_abc" }

describe("resolveTriageModel — OpenRouter attribution", () => {
	it("sends the app-attribution headers on every OpenRouter call", async () => {
		const captured = await captureRequest(openRouterEnv)

		expect(captured.url).toContain("openrouter.ai")
		// `HTTP-Referer` is what creates the app page — a title alone does nothing.
		expect(captured.headers["http-referer"]).toBe("https://maple.dev")
		expect(captured.headers["x-title"]).toBe("Maple")
	})

	it("tags the request body with surface, org and session", async () => {
		const captured = await captureRequest(openRouterEnv, tags)

		expect(captured.body).toMatchObject({
			user: "org_123",
			session_id: "chat_abc",
			trace: { trace_name: "chat" },
		})
	})

	it("omits session_id when the caller has no session to group by", async () => {
		const captured = await captureRequest(openRouterEnv, { surface: "ai-triage", orgId: "org_123" })

		expect(captured.body).toMatchObject({ user: "org_123", trace: { trace_name: "ai-triage" } })
		expect(captured.body).not.toHaveProperty("session_id")
	})

	it("truncates an over-long session id to OpenRouter's 256-character limit", async () => {
		const captured = await captureRequest(openRouterEnv, { ...tags, sessionId: "s".repeat(400) })

		expect(captured.body.session_id).toHaveLength(256)
	})

	it("keeps the headers and tags off the Workers AI path", async () => {
		const captured = await captureRequest(
			{ MAPLE_LLM_PROVIDER: "workers-ai", CLOUDFLARE_API_KEY: "test-key" },
			tags,
		)

		expect(captured.url).not.toContain("openrouter.ai")
		expect(captured.headers).not.toHaveProperty("http-referer")
		expect(captured.headers).not.toHaveProperty("x-title")
		// These are OpenRouter's body fields; Cloudflare must never be sent them.
		expect(captured.body).not.toHaveProperty("user")
		expect(captured.body).not.toHaveProperty("session_id")
		expect(captured.body).not.toHaveProperty("trace")
	})
})
