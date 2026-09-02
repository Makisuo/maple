// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
/**
 * Wire-level proof that OpenRouter calls are attributed and tagged.
 *
 * `LLMClient.prepare` is deliberately not used here: it returns the *protocol* body, which is built
 * before `http.body` is overlaid onto it, so it cannot see the tags at all. The only place the tags
 * and the attribution headers exist together is the outgoing HTTP request — so the test swaps
 * `FetchHttpClient.Fetch` for a capture and reads what would have gone over the wire.
 *
 * The fake responds 400, which `@opencode-ai/ai` classifies as non-retryable. That keeps the run to a
 * single request with no backoff; the resulting failure is expected and ignored.
 */
import { LLM, type LanguageModel } from "@opencode-ai/ai"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import {
	contextLimitOf,
	layerLlm,
	outputLimitOf,
	resolveLensModel,
	resolveTriageModel,
	type LlmCallTags,
	type LlmEnv,
} from "./Llm"

interface CapturedRequest {
	readonly url: string
	readonly headers: Record<string, string>
	readonly body: Record<string, unknown>
}

/**
 * Run one `LLM.generate` against a fetch that records the request instead of sending it.
 *
 * `resolve` picks which resolver builds the model, because the lens stage differs from triage in its
 * defaults and the only honest way to check a default is to watch what leaves.
 */
const captureRequest = (
	env: LlmEnv,
	tags?: LlmCallTags,
	resolve: (env: LlmEnv, tags?: LlmCallTags) => LanguageModel = resolveTriageModel,
): Effect.Effect<CapturedRequest> =>
	Effect.gen(function* () {
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
			model: resolve(env, tags),
			system: "You are concise.",
			prompt: "hi",
		})

		yield* LLM.generate(request).pipe(
			Effect.ignore,
			Effect.provide(
				layerLlm(env).pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fakeFetch))),
			),
		)

		if (captured === undefined) return yield* Effect.die("no request reached the transport")
		return captured
	})

const openRouterEnv: LlmEnv = { OPENROUTER_API_KEY: "test-key" }

/** `DEFAULT_MODEL_LIMITS.context` in Llm.ts — what a model absent from the table falls back to. */
const DEFAULT_MODEL_LIMITS_CONTEXT = 128_000

const tags: LlmCallTags = { surface: "chat", orgId: "org_123", sessionId: "chat_abc" }

describe("resolveTriageModel — OpenRouter attribution", () => {
	it.live("sends the app-attribution headers on every OpenRouter call", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(openRouterEnv)

			expect(captured.url).toContain("openrouter.ai")
			// `HTTP-Referer` is what creates the app page — a title alone does nothing.
			expect(captured.headers["http-referer"]).toBe("https://maple.dev")
			expect(captured.headers["x-title"]).toBe("Maple")
		}),
	)

	it.live("tags the request body with surface, org and session", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(openRouterEnv, tags)

			expect(captured.body).toMatchObject({
				user: "org_123",
				session_id: "chat_abc",
				trace: { trace_name: "chat" },
			})
		}),
	)

	it.live("omits session_id when the caller has no session to group by", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(openRouterEnv, { surface: "ai-triage", orgId: "org_123" })

			expect(captured.body).toMatchObject({ user: "org_123", trace: { trace_name: "ai-triage" } })
			expect(captured.body).not.toHaveProperty("session_id")
		}),
	)

	it.live("truncates an over-long session id to OpenRouter's 256-character limit", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(openRouterEnv, { ...tags, sessionId: "s".repeat(400) })

			expect(captured.body.session_id).toHaveLength(256)
		}),
	)

	it.live("keeps the headers and tags off the Workers AI path", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(
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
		}),
	)
})

describe("reasoning effort", () => {
	it.live("sends no reasoning field for triage unless one is configured", () =>
		Effect.gen(function* () {
			// This resolver serves chat, AI triage and the validator at once. Adding the knob must not
			// retune three stages as a side effect.
			const captured = yield* captureRequest(openRouterEnv, tags)

			expect(captured.body).not.toHaveProperty("reasoning")
		}),
	)

	it.live("sends the configured triage effort", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(
				{ ...openRouterEnv, MAPLE_TRIAGE_REASONING_EFFORT: "high" },
				tags,
			)

			expect(captured.body).toMatchObject({ reasoning: { effort: "high" } })
		}),
	)

	it.live("defaults a lens pass to low, because a fan-out of five multiplies whatever it spends", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(openRouterEnv, tags, resolveLensModel)

			expect(captured.body).toMatchObject({ reasoning: { effort: "low" } })
		}),
	)

	it.live("lets a lens be raised past the default", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(
				{ ...openRouterEnv, MAPLE_LENS_REASONING_EFFORT: "medium" },
				tags,
				resolveLensModel,
			)

			expect(captured.body).toMatchObject({ reasoning: { effort: "medium" } })
		}),
	)

	it.live("omits the field entirely on `off`, rather than sending a zero budget", () =>
		Effect.gen(function* () {
			// The escape hatch: a model that does not support reasoning must see no `reasoning` key.
			const captured = yield* captureRequest(
				{ ...openRouterEnv, MAPLE_LENS_REASONING_EFFORT: "off" },
				tags,
				resolveLensModel,
			)

			expect(captured.body).not.toHaveProperty("reasoning")
		}),
	)

	it.live("falls back to the default on an unrecognized value rather than failing the call", () =>
		Effect.gen(function* () {
			// Read on a request path in a Worker: a typo'd env var must not take the agent down.
			const captured = yield* captureRequest(
				{ ...openRouterEnv, MAPLE_LENS_REASONING_EFFORT: "maximum" },
				tags,
				resolveLensModel,
			)

			expect(captured.body).toMatchObject({ reasoning: { effort: "low" } })
		}),
	)

	it.live("keeps reasoning off the Workers AI path", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(
				{ MAPLE_LLM_PROVIDER: "workers-ai", CLOUDFLARE_API_KEY: "test-key" },
				tags,
				resolveLensModel,
			)

			// `reasoning` is OpenRouter's field, namespaced under its own provider options.
			expect(captured.body).not.toHaveProperty("reasoning")
		}),
	)
})

describe("resolveTriageModel — context limits", () => {
	it("attaches the configured model's window, which upstream leaves unstated", () => {
		// `@opencode-ai/ai` declares `ModelLimits` but no provider populates it, so before this every
		// model reported `undefined` and nothing could tell when a transcript was near the wall.
		//
		// The model is NAMED rather than left to the default: this asserts that a model in the table
		// gets that table's window, which is a fact about the mechanism. Reading it off whatever
		// `DEFAULT_OPENROUTER_MODEL` happens to be made a routine model swap fail here instead —
		// which is exactly what happened when the default moved to glm-5.3-flash.
		const model = resolveTriageModel({
			...openRouterEnv,
			MAPLE_TRIAGE_MODEL_OPENROUTER: "openai/gpt-5.6-luna",
		})

		expect(contextLimitOf(model)).toBe(1_050_000)
		expect(outputLimitOf(model)).toBe(128_000)
	})

	it("attaches the default model's window without it having to be named", () => {
		// The pair above and below pin a model on purpose; this one is the check that
		// DEFAULT_OPENROUTER_MODEL is itself in the table. A default that is missing from it silently
		// takes DEFAULT_MODEL_LIMITS and compacts earlier than it needs to.
		const model = resolveTriageModel(openRouterEnv)

		expect(contextLimitOf(model)).not.toBe(DEFAULT_MODEL_LIMITS_CONTEXT)
	})

	it("falls back to a conservative window for a model it does not know", () => {
		// Too low costs a summarization call; too high costs the whole turn. Unknown means low.
		const model = resolveTriageModel({
			...openRouterEnv,
			MAPLE_TRIAGE_MODEL_OPENROUTER: "some/model-shipped-after-this-table",
		})

		expect(contextLimitOf(model)).toBe(128_000)
	})

	it("lets the environment override the table", () => {
		const model = resolveTriageModel({
			...openRouterEnv,
			MAPLE_TRIAGE_MODEL_CONTEXT: "64000",
			MAPLE_TRIAGE_MODEL_OUTPUT: "4000",
		})

		expect(contextLimitOf(model)).toBe(64_000)
		expect(outputLimitOf(model)).toBe(4_000)
	})

	it("ignores an unparseable or nonsensical override rather than trusting it", () => {
		// A zero or negative window would make every turn look overflowed on its first step.
		// Model named for the same reason as above — the assertion is that the bad override is
		// discarded in favour of the TABLE, not that the default happens to be this model.
		for (const bad of ["", "not-a-number", "0", "-5", "1.5"]) {
			const model = resolveTriageModel({
				...openRouterEnv,
				MAPLE_TRIAGE_MODEL_OPENROUTER: "openai/gpt-5.6-luna",
				MAPLE_TRIAGE_MODEL_CONTEXT: bad,
			})
			expect(contextLimitOf(model)).toBe(1_050_000)
		}
	})
})
