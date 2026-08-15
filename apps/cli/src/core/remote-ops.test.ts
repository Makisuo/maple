import { beforeEach, describe, expect, it } from "bun:test"
import { Effect, Exit, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Remote from "./remote-ops"
import { makeV2Client, toV2Timestamp } from "./v2-client"

// These tests exist because the endpoint this replaced broke silently.
//
// The old remote executor POSTed `{ pipe, params }` while the server contract
// had been renamed to `pipeName`. Every remote command failed payload decode
// for months, and the executor's test never noticed — it stubbed `fetch` and
// asserted only on the decoded response, never on the request it sent.
//
// So the rule here: assert the OUTBOUND request. URL, method, and body shape
// are the contract with the server, and they are what drifts.
//
// Two mechanics matter for the harness itself:
//
//  - Plain awaited tests, not `it.effect`. The stub is global state, and
//    overlapping test fibers let one test's stub answer another's request.
//  - The stub is installed ONCE, at module scope, with a swappable responder.
//    `FetchHttpClient` captures `globalThis.fetch` when the client is first
//    built, so reassigning it per test only ever affects whichever test ran
//    first — every later test's request lands in the first test's recorder.

interface CapturedRequest {
	readonly url: string
	readonly method: string
	readonly authorization: string | null
	readonly body: Record<string, unknown>
}

type StubResponse = Record<string, unknown>

const decodeCapturedBody = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

let requests: Array<CapturedRequest> = []
let responder: (url: string) => StubResponse = () => ({})

const fetchStub = Object.assign(
	async (input: string | URL | Request, init?: RequestInit) => {
		// Read through `Request` rather than poking at `init.body`: the HTTP client
		// may send a stream or a Uint8Array, and stringifying those yields garbage
		// instead of the payload we mean to assert on.
		const request =
			input instanceof Request && init === undefined
				? input
				: new Request(input instanceof Request ? input.url : String(input), init)
		const text = await request.clone().text()
		requests.push({
			url: request.url,
			method: request.method.toUpperCase(),
			authorization: request.headers.get("authorization"),
			body: text.length > 0 ? decodeCapturedBody(JSON.parse(text)) : {},
		})
		return new Response(JSON.stringify(responder(request.url)), {
			status: 200,
			headers: { "content-type": "application/json" },
		})
	},
	{ preconnect: globalThis.fetch.preconnect },
) satisfies typeof fetch

globalThis.fetch = fetchStub

const stubV2 = (respond: (url: string) => StubResponse) => {
	responder = respond
	return requests
}

const RANGE = { startTime: "2026-08-15 12:00:00", endTime: "2026-08-15 13:00:00" }

const v2Client = makeV2Client("https://api.maple.test", "maple_ak_testtoken").pipe(
	Effect.provide(FetchHttpClient.layer),
)

const listEnvelope = (data: ReadonlyArray<unknown>) => ({
	object: "list",
	data,
	has_more: false,
	next_cursor: null,
})

beforeEach(() => {
	requests = []
	responder = () => listEnvelope([])
})

describe("remote-ops request shapes", () => {
	it("listServices GETs /v2/services with the window and a bearer token", async () => {
		const requests = stubV2(() => listEnvelope([]))
		await Effect.runPromise(Effect.flatMap(v2Client, (v2) => Remote.listServices(v2, { range: RANGE })))

		expect(requests).toHaveLength(1)
		const request = requests[0]!
		expect(request.method).toBe("GET")
		expect(request.authorization).toBe("Bearer maple_ak_testtoken")
		const url = new URL(request.url)
		expect(url.pathname).toBe("/v2/services")
		// The window must be ISO-8601 UTC; the CLI's own `Range` is
		// ClickHouse-style and the v2 `Timestamp` schema rejects it.
		expect(url.searchParams.get("start_time")).toBe("2026-08-15T12:00:00.000Z")
		expect(url.searchParams.get("end_time")).toBe("2026-08-15T13:00:00.000Z")
	})

	it("searchTraces POSTs /v2/traces/search scoped to root spans", async () => {
		const requests = stubV2(() => listEnvelope([]))
		await Effect.runPromise(
			Effect.flatMap(v2Client, (v2) =>
				Remote.searchTraces(v2, { range: RANGE, service: "api", hasError: true, limit: 5 }),
			),
		)

		expect(requests).toHaveLength(1)
		const request = requests[0]!
		expect(request.method).toBe("POST")
		expect(new URL(request.url).pathname).toBe("/v2/traces/search")
		expect(request.body).toMatchObject({
			start_time: "2026-08-15T12:00:00.000Z",
			end_time: "2026-08-15T13:00:00.000Z",
			limit: 5,
			// Without span_scope the endpoint would return non-root spans and the
			// rows would no longer describe one trace each.
			filters: { span_scope: "root", service_name: "api", has_error: true },
		})
	})

	it("searchTraces refuses a span-name filter instead of silently searching roots", async () => {
		const requests = stubV2(() => listEnvelope([]))
		const exit = await Effect.runPromise(
			Effect.flatMap(v2Client, (v2) =>
				Effect.exit(Remote.searchTraces(v2, { range: RANGE, spanName: "GET /checkout" })),
			),
		)

		expect(Exit.isFailure(exit)).toBe(true)
		// The point is that it never reached the network: a root-span answer to a
		// span-name query looks valid and is wrong.
		expect(requests).toHaveLength(0)
	})

	it("searchLogs refuses --offset rather than ignoring it", async () => {
		const requests = stubV2(() => listEnvelope([]))
		const exit = await Effect.runPromise(
			Effect.flatMap(v2Client, (v2) =>
				Effect.exit(Remote.searchLogs(v2, { range: RANGE, offset: 40 })),
			),
		)

		expect(Exit.isFailure(exit)).toBe(true)
		expect(requests).toHaveLength(0)
	})

	it("inspectTrace derives the log window from the trace's own bounds", async () => {
		const traceId = "7f3a4b5c6d7e8f901234567890abcdef"
		const requests = stubV2((url) =>
			url.includes("/logs/search")
				? listEnvelope([])
				: {
						id: traceId,
						object: "trace",
						start_time: "2026-08-15T12:30:00.000Z",
						end_time: "2026-08-15T12:30:02.000Z",
						duration_ms: 2000,
						span_count: 0,
						service_count: 0,
						truncated: false,
						spans: [],
					},
		)
		await Effect.runPromise(Effect.flatMap(v2Client, (v2) => Remote.inspectTrace(v2, { traceId })))

		expect(requests).toHaveLength(2)
		expect(new URL(requests[0]!.url).pathname).toBe(`/v2/traces/${traceId}`)
		// `maple trace <id>` takes no time flags, so the window has to come from
		// the trace itself — a wrong window here silently drops its logs.
		expect(requests[1]!.body).toMatchObject({
			start_time: "2026-08-15T12:30:00.000Z",
			end_time: "2026-08-15T12:30:02.000Z",
			filters: { trace_id: traceId },
		})
	})
})

describe("toV2Timestamp", () => {
	it("converts the CLI's ClickHouse-style UTC to the v2 wire format", () => {
		expect(toV2Timestamp("2026-08-15 12:00:00")).toBe("2026-08-15T12:00:00.000Z")
	})
})
