import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { sendTestEventEffect } from "./use-ingest-connection"

interface RecordedRequest {
	readonly url: string
	readonly method: string
	readonly headers: Headers
	readonly body: unknown
}

const runWithResponse = (recorded: Array<RecordedRequest>, response: Response) => {
	const fetchStub: typeof globalThis.fetch = async (input, init) => {
		const body =
			typeof init?.body === "string"
				? JSON.parse(init.body)
				: init?.body instanceof Uint8Array
					? JSON.parse(new TextDecoder().decode(init.body))
					: undefined
		recorded.push({
			url: input instanceof Request ? input.url : String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body,
		})
		return response
	}

	return sendTestEventEffect("maple_pk_test").pipe(
		Effect.provide(FetchHttpClient.layer),
		Effect.provideService(FetchHttpClient.Fetch, fetchStub),
	)
}

describe("sendTestEventEffect", () => {
	it.effect("posts a deterministic synthetic trace using the Effect clock", () =>
		Effect.gen(function* () {
			const now = Date.UTC(2026, 7, 11, 12, 0, 0)
			yield* TestClock.setTime(now)
			const recorded: Array<RecordedRequest> = []

			yield* runWithResponse(recorded, new Response(null, { status: 202 }))

			assert.lengthOf(recorded, 1)
			assert.strictEqual(recorded[0]?.url, "https://ingest.maple.dev/v1/traces")
			assert.strictEqual(recorded[0]?.method, "POST")
			assert.strictEqual(recorded[0]?.headers.get("authorization"), "Bearer maple_pk_test")
			const payload = recorded[0]?.body as {
				resourceSpans: Array<{
					scopeSpans: Array<{
						spans: Array<{ startTimeUnixNano: string; endTimeUnixNano: string }>
					}>
				}>
			}
			const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
			assert.strictEqual(span.startTimeUnixNano, `${now - 87}000000`)
			assert.strictEqual(span.endTimeUnixNano, `${now}000000`)
		}),
	)

	it.effect("fails with a schema-backed rejection on a non-2xx response", () =>
		Effect.gen(function* () {
			const error = yield* runWithResponse([], new Response(null, { status: 401 })).pipe(Effect.flip)
			if (error._tag !== "@maple/web/TestEventIngestRejected") {
				return assert.fail(`Expected tagged ingest rejection, got ${error._tag}`)
			}
			assert.strictEqual(error.status, 401)
		}),
	)
})
