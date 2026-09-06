// The served response's identity, read off the wire and written to the
// model-call span.
//
// Every OpenAI-chat stream chunk carries the provider's response id and the
// model that actually served it (OpenRouter routes, so it can differ from the
// request). `@opencode-ai/ai`'s protocol keeps the stream's usage object and
// drops both — its finish event's `providerMetadata.openai` IS the usage — so
// `gen_ai.response.id` and `gen_ai.response.model` never reached the span.
// The id is the one fact a gateway's own trace of the call (OpenRouter
// Broadcast) shares with ours, and what Agent Sessions collapses the two
// observations on; without it every call through a broadcasting gateway
// counts twice for Maple's own sessions.
//
// So the HTTP client the executor runs through tees the response body, reads
// the first data frame off the copy, and stamps the enclosing model-call span
// — the one `turn.ts` opens per attempt. Nothing is buffered on the served
// branch and the copy is cancelled the moment the frame is in hand. This is
// Maple behaviour at the `Llm.ts` seam, not a wrapper around the package.

import { Effect, Layer, Option, Schema } from "effect"
import type { Tracer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"

export interface ResponseIdentity {
	readonly id?: string
	readonly model?: string
}

/** The two top-level fields of an OpenAI-chat chunk this reads; the rest is
 *  the delta, which is the served branch's business. */
const decodeChunkIdentity = Schema.decodeUnknownOption(
	Schema.fromJsonString(
		Schema.Struct({ id: Schema.optionalKey(Schema.String), model: Schema.optionalKey(Schema.String) }),
	),
)

/**
 * The identity the first SSE data frame carries, or nothing when no complete
 * data frame in `text` names one. Comment lines (OpenRouter sends
 * `: OPENROUTER PROCESSING` while it routes) and `[DONE]` are skipped; a frame
 * that is not JSON ends the search — the stream is not what this expects.
 */
export const responseIdentityFromSse = (text: string): ResponseIdentity | undefined => {
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue
		const payload = line.slice("data:".length).trim()
		if (payload === "" || payload === "[DONE]") continue
		const chunk = decodeChunkIdentity(payload)
		if (Option.isNone(chunk)) return undefined
		const { id, model } = chunk.value
		const identity: ResponseIdentity = {
			...(id !== undefined && id !== "" ? { id } : undefined),
			...(model !== undefined && model !== "" ? { model } : undefined),
		}
		if (identity.id !== undefined || identity.model !== undefined) return identity
	}
	return undefined
}

/** How far into a stream to look before giving up: the first frame arrives
 *  within the first few hundred bytes on every provider seen. */
const MAX_SCAN_BYTES = 16 * 1024

/** Read `body` up to the first complete data frame naming an identity, then
 *  cancel it — this is the tee's copy, so cancelling frees its buffer. */
const readIdentity = async (body: ReadableStream<Uint8Array>): Promise<ResponseIdentity | undefined> => {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let text = ""
	let scanned = 0
	try {
		while (scanned < MAX_SCAN_BYTES) {
			const { value, done } = await reader.read()
			if (done) return undefined
			scanned += value.byteLength
			text += decoder.decode(value, { stream: true })
			const complete = text.lastIndexOf("\n")
			if (complete === -1) continue
			const identity = responseIdentityFromSse(text.slice(0, complete))
			if (identity !== undefined) return identity
			text = text.slice(complete + 1)
		}
		return undefined
	} finally {
		await reader.cancel().catch(() => undefined)
	}
}

/**
 * The nearest enclosing model-call span — the one `turn.ts` opens per attempt
 * with `gen_ai.operation.name = "chat"` — or nothing when the request runs
 * under no such span (a non-model call through the same client).
 */
export const modelCallSpan = (span: Tracer.AnySpan): Tracer.Span | undefined => {
	let current: Tracer.AnySpan | undefined = span
	while (current !== undefined && current._tag === "Span") {
		if (current.attributes.get("gen_ai.operation.name") === "chat") return current
		current = Option.isSome(current.parent) ? current.parent.value : undefined
	}
	return undefined
}

/** `fetch` that tees an event stream and stamps `span` with the identity its
 *  first frame carries. Any other response passes through untouched. */
const identifyingFetch =
	(span: Tracer.Span, fetch: typeof globalThis.fetch): typeof globalThis.fetch =>
	async (input, init) => {
		const response = await fetch(input, init)
		const contentType = response.headers.get("content-type") ?? ""
		if (response.body === null || !contentType.includes("text/event-stream")) return response
		const [served, observed] = response.body.tee()
		void readIdentity(observed).then(
			(identity) => {
				if (identity?.id !== undefined) span.attribute("gen_ai.response.id", identity.id)
				if (identity?.model !== undefined) span.attribute("gen_ai.response.model", identity.model)
			},
			() => undefined,
		)
		return new Response(served, response)
	}

/**
 * The client with the identity stamping on: each request resolves the
 * model-call span it runs under, and runs with a `Fetch` bound to it. A request
 * under no model-call span runs exactly as before.
 */
export const withResponseIdentity = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
	HttpClient.transform(client, (effect) =>
		Effect.gen(function* () {
			const current = yield* Effect.option(Effect.currentParentSpan)
			const span = Option.isSome(current) ? modelCallSpan(current.value) : undefined
			if (span === undefined) return yield* effect
			const fetch = yield* FetchHttpClient.Fetch
			return yield* Effect.provideService(effect, FetchHttpClient.Fetch, identifyingFetch(span, fetch))
		}),
	)

export const layerResponseIdentity: Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient> =
	Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, withResponseIdentity))
