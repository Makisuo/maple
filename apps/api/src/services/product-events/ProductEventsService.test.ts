import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http"
import { makeProductEvents, toProductEventLine } from "./ProductEventsService"

interface Captured {
	readonly url: string
	readonly method: string
	readonly headers: Record<string, string>
	readonly body: string
}

/** An HttpClient that records the request and answers with the given statuses in order. */
const stubClient = (statuses: ReadonlyArray<number>) => {
	const captured: Array<Captured> = []
	let call = 0
	const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
		Effect.gen(function* () {
			const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
			captured.push({ url: request.url, method: request.method, headers: { ...request.headers }, body })
			const status = statuses[Math.min(call, statuses.length - 1)] ?? 200
			call += 1
			return HttpClientResponse.fromWeb(request, new Response(null, { status }))
		}),
	)
	return { client, captured }
}

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0)

describe("ProductEventsService", () => {
	it("projects an event onto the /v1/events wire line", () => {
		const line = toProductEventLine(
			{
				name: "plan_started",
				userId: "user_1",
				groupId: "org_1",
				attributes: { plan_id: "startup", "": "dropped", empty: "" },
			},
			NOW,
		)
		assert.deepStrictEqual(line, {
			name: "plan_started",
			timestamp: "2026-08-17T12:00:00.000Z",
			source: "server",
			service_name: "maple-api",
			user_id: "user_1",
			group_id: "org_1",
			attributes: { plan_id: "startup" },
		})
	})

	it("caps attributes at 32 keys and 1024-char values, and omits empty ids", () => {
		const attributes: Record<string, string> = {}
		for (let i = 0; i < 40; i++) attributes[`k${i}`] = "x".repeat(2000)
		const line = toProductEventLine({ name: "signup_completed", userId: "", attributes }, NOW)
		assert.isUndefined(line.user_id)
		assert.isUndefined(line.group_id)
		assert.strictEqual(Object.keys(line.attributes ?? {}).length, 32)
		assert.strictEqual(line.attributes?.k0?.length, 1024)
	})

	it.effect("POSTs one NDJSON line with the bearer ingest key", () =>
		Effect.gen(function* () {
			const { client, captured } = stubClient([200])
			const events = makeProductEvents({
				httpClient: client,
				endpoint: "https://ingest.example.test/",
				ingestKey: "maple_sk_test",
			})
			assert.isTrue(events.enabled)
			yield* events.track({
				name: "signup_completed",
				userId: "user_abc",
				attributes: { email_domain: "example.com" },
				timestamp: NOW,
			})
			assert.strictEqual(captured.length, 1)
			const request = captured[0]!
			assert.strictEqual(request.method, "POST")
			assert.strictEqual(request.url, "https://ingest.example.test/v1/events")
			assert.strictEqual(request.headers.authorization, "Bearer maple_sk_test")
			assert.match(request.headers["content-type"] ?? "", /application\/x-ndjson/)
			assert.isTrue(request.body.endsWith("\n"))
			const lines = request.body.trimEnd().split("\n")
			assert.strictEqual(lines.length, 1)
			assert.deepStrictEqual(JSON.parse(lines[0]!), {
				name: "signup_completed",
				timestamp: "2026-08-17T12:00:00.000Z",
				source: "server",
				service_name: "maple-api",
				user_id: "user_abc",
				attributes: { email_domain: "example.com" },
			})
		}),
	)

	it.effect("retries once on 5xx and never fails the caller", () =>
		Effect.gen(function* () {
			const { client, captured } = stubClient([503, 503, 503])
			const events = makeProductEvents({
				httpClient: client,
				endpoint: "https://ingest.example.test",
				ingestKey: "k",
			})
			yield* events.track({ name: "plan_started", groupId: "org_1" })
			assert.strictEqual(captured.length, 2)
		}),
	)

	it.effect("does not retry a 4xx", () =>
		Effect.gen(function* () {
			const { client, captured } = stubClient([400])
			const events = makeProductEvents({
				httpClient: client,
				endpoint: "https://ingest.example.test",
				ingestKey: "k",
			})
			yield* events.track({ name: "plan_started", groupId: "org_1" })
			assert.strictEqual(captured.length, 1)
		}),
	)

	it.effect("is a no-op without an ingest key", () =>
		Effect.gen(function* () {
			const { client, captured } = stubClient([200])
			const events = makeProductEvents({
				httpClient: client,
				endpoint: "https://ingest.example.test",
				ingestKey: undefined,
			})
			assert.isFalse(events.enabled)
			yield* events.track({ name: "plan_started", groupId: "org_1" })
			assert.strictEqual(captured.length, 0)
		}),
	)
})
