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
 * The translation is *almost* a pass-through. `env.AI.run(model, inputs, { returnRawResponse: true })`
 * takes the same OpenAI-compatible payload the provider already builds — `messages`, `tools`,
 * `tool_choice`, `stream`, `stream_options`, `max_tokens`, `temperature` — and answers with an
 * OpenAI-format SSE `Response`. Only the `model` field moves, from the body to the first argument.
 *
 * The exception, and the reason `stripNativeTrailer` exists: after the OpenAI-shaped deltas Workers
 * AI appends one frame of its *own* native accounting —
 * `{"response":"","usage":{...,"neurons":260.1}}` — which is not an OpenAI chunk and which the
 * vendored provider rejects with "Invalid ... stream event". Because it arrives last, the whole
 * reply streams successfully and then the turn dies on the final frame. Filtering it here keeps the
 * fix at the Maple seam, where `lib/llm/MAPLE.md` says provider-specific behaviour belongs.
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

/**
 * Whether `value` is an `Ai` binding this shim can drive.
 *
 * Worth being loud about, because the failure is silent: when this returns false the vendored
 * provider falls through to the REST endpoint with `BINDING_PLACEHOLDER` credentials and 401s at
 * the *end* of a turn, which reads like a model outage rather than a misconfiguration. Local dev
 * declares a plain `ai` binding in `wrangler.jsonc` while deploys attach an AI Gateway resource
 * (`apps/api/alchemy.run.ts`), so the two shapes have to satisfy the same check.
 */
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
 * Whether an SSE `data:` payload is Workers AI's native accounting trailer rather than an OpenAI
 * chunk.
 *
 * Deliberately narrow. It matches the trailer's exact signature — a `response` string plus a
 * `usage` object carrying `neurons`, and no `choices`/`object` — so a real OpenAI chunk can never
 * be mistaken for it, including the `stream_options: {include_usage: true}` chunk, which carries
 * `choices: []` and `object: "chat.completion.chunk"`.
 */
const isNativeWorkersAiTrailer = (payload: string): boolean => {
	if (payload === "[DONE]") return false
	try {
		const value: unknown = JSON.parse(payload)
		if (typeof value !== "object" || value === null) return false
		const frame = value as Record<string, unknown>
		if ("choices" in frame || "object" in frame) return false
		if (typeof frame.response !== "string") return false
		const usage = frame.usage
		return typeof usage === "object" && usage !== null && "neurons" in usage
	} catch {
		return false
	}
}

/**
 * Drop the native trailer from an SSE body, passing every other byte through unchanged.
 *
 * Frame-aligned rather than line-based: SSE separates events with a blank line, and rewriting at
 * any finer granularity risks corrupting a multi-line `data:` payload.
 */
const stripNativeTrailer = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
	const decoder = new TextDecoder()
	const encoder = new TextEncoder()
	let buffer = ""

	const emit = (frame: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
		const payload = frame
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
		if (payload !== "" && isNativeWorkersAiTrailer(payload)) return
		controller.enqueue(encoder.encode(`${frame}\n\n`))
	}

	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true })
				const frames = buffer.split("\n\n")
				buffer = frames.pop() ?? ""
				for (const frame of frames) emit(frame, controller)
			},
			flush(controller) {
				buffer += decoder.decode()
				if (buffer.trim() !== "") emit(buffer.replace(/\n+$/, ""), controller)
			},
		}),
	)
}

/**
 * Wrap `fallback` so Workers AI chat completions go through `binding` instead.
 * Without a usable `AI` binding this returns `fallback` unchanged, so a stage with no binding still
 * works through the REST endpoint as long as a Cloudflare API token is configured.
 */
export const workersAiHttpClient = (
	fallback: HttpClient.HttpClient,
	binding: unknown,
): HttpClient.HttpClient => {
	if (!isWorkersAiBinding(binding)) {
		// A binding that is *present but unusable* is a misconfiguration, not the documented
		// keyless-unavailable fallback, and it is otherwise indistinguishable from a model outage:
		// every call quietly becomes a REST request with placeholder credentials and 401s at the end
		// of a turn. Say so once, at layer build, rather than per request.
		if (binding !== undefined && binding !== null) {
			console.warn(
				"[workers-ai] the AI binding is present but has no `run` method; " +
					"model calls will fall back to the REST endpoint",
			)
		}
		return fallback
	}
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
					try: async () => {
						const response = await ai.run(model, inputs, { returnRawResponse: true, signal })
						if (!response.body) return response
						return new Response(stripNativeTrailer(response.body), {
							status: response.status,
							statusText: response.statusText,
							headers: response.headers,
						})
					},
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
