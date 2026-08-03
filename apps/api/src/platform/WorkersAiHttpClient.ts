/**
 * `HttpClient` shim that routes Cloudflare Workers AI traffic through the Worker's `AI` binding
 * instead of the public REST endpoint.
 *
 * `@maple/llm`'s `CloudflareWorkersAI` provider posts an OpenAI-compatible chat body to
 * `https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1/chat/completions` with an API token.
 * That is a *different billing and rate-limit path* from `env.AI.run(...)`, which is keyless and
 * draws on the account's included neuron allocation — the path Maple's chat and triage run on.
 * The `Ai` binding exposes no `fetch`, so intercepting at the `HttpClient` seam
 * is the only way to keep the vendored provider *and* the binding.
 *
 * The translation is a pass-through. `env.AI.run(model, inputs, { returnRawResponse: true })` takes
 * the same OpenAI-compatible payload the provider already builds — `messages`, `tools`,
 * `tool_choice`, `stream`, `stream_options`, `max_tokens`, `temperature` — and answers with a raw
 * OpenAI-format SSE `Response`. Only the `model` field moves, from the body to the first argument.
 *
 * Requests that are not Workers AI chat completions fall through to the wrapped client untouched.
 */
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http"

/** The subset of the Cloudflare `Ai` binding this shim uses. */
export interface WorkersAiBinding {
	readonly run: (
		model: string,
		inputs: Record<string, unknown>,
		options: { readonly returnRawResponse: true; readonly signal?: AbortSignal },
	) => Promise<Response>
}

export const isWorkersAiBinding = (value: unknown): value is WorkersAiBinding =>
	typeof value === "object" && value !== null && typeof (value as { run?: unknown }).run === "function"

/**
 * Matches the chat-completions path of the Workers AI REST surface — both the direct
 * `.../accounts/{id}/ai/v1/chat/completions` form and an AI Gateway `.../compat/chat/completions`.
 */
const isWorkersAiChatUrl = (url: string): boolean => {
	try {
		const { pathname } = new URL(url)
		return (
			pathname.endsWith("/chat/completions") &&
			(pathname.includes("/ai/v1/") || pathname.includes("/compat/"))
		)
	} catch {
		return false
	}
}

const encodeError = (request: HttpClientRequest.HttpClientRequest, cause: unknown) =>
	new HttpClientError.HttpClientError({
		reason: new HttpClientError.EncodeError({ request, cause }),
	})

/**
 * Read the already-serialized request body back out as a JSON object. The provider always sets a
 * JSON body, so anything else means the request did not come from where we think it did.
 */
const readJsonBody = (request: HttpClientRequest.HttpClientRequest) =>
	Effect.try({
		try: (): Record<string, unknown> => {
			const body = request.body
			const text =
				body._tag === "Uint8Array"
					? new TextDecoder().decode(body.body)
					: body._tag === "Raw" && typeof body.body === "string"
						? body.body
						: undefined
			if (text === undefined) {
				throw new Error(`Workers AI request carries a ${body._tag} body, expected serialized JSON`)
			}
			const parsed: unknown = JSON.parse(text)
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new Error("Workers AI request body is not a JSON object")
			}
			return { ...(parsed as Record<string, unknown>) }
		},
		catch: (cause) => encodeError(request, cause),
	})

/**
 * Wrap `fallback` so Workers AI chat completions go through `binding` instead.
 * Without a usable `AI` binding this returns `fallback` unchanged, so a stage with no binding still
 * works through the REST endpoint as long as a Cloudflare API token is configured.
 */
export const workersAiHttpClient = (
	fallback: HttpClient.HttpClient,
	binding: unknown,
): HttpClient.HttpClient => {
	if (!isWorkersAiBinding(binding)) return fallback
	const ai = binding

	return HttpClient.make((request, _url, signal) => {
		if (request.method !== "POST" || !isWorkersAiChatUrl(request.url)) {
			return fallback.execute(request)
		}
		return readJsonBody(request).pipe(
			Effect.flatMap((body) => {
				const { model, ...inputs } = body
				if (typeof model !== "string") {
					return Effect.fail(
						encodeError(
							request,
							new Error("Workers AI request body has no string `model` field"),
						),
					)
				}
				return Effect.tryPromise({
					try: () => ai.run(model, inputs, { returnRawResponse: true, signal }),
					catch: (cause) =>
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({
								request,
								cause,
								description: "Cloudflare AI binding call failed",
							}),
						}),
				})
			}),
			Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
		)
	})
}

/**
 * Layer form: replaces the `HttpClient` already in context with one that shims Workers AI,
 * reading the `AI` binding out of the supplied worker env record.
 */
export const layerWorkersAi = (
	env: Record<string, unknown>,
): Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient> =>
	Layer.effect(
		HttpClient.HttpClient,
		Effect.map(HttpClient.HttpClient, (fallback) => workersAiHttpClient(fallback, env.AI)),
	)
