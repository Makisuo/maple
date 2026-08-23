import { describe, it } from "@effect/vitest"
import { Effect, Layer, Schema, Scope } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { afterEach, expect, vi } from "vitest"
import { make, makeHandle, MapleEvents } from "./events.js"

interface PostedBatch {
	readonly url: string
	readonly headers: Record<string, string>
	readonly contentType: string | undefined
	readonly lines: Array<Record<string, unknown>>
}

/** One NDJSON line as the gateway would parse it. */
const parseLine = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

/** An `HttpClient` that records every NDJSON POST and answers with `status`. */
const stubClient = (status = 200) => {
	const posts: Array<PostedBatch> = []
	const client = HttpClient.make((request) => {
		const body = request.body
		const text = body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : ""
		posts.push({
			url: request.url,
			headers: { ...request.headers },
			contentType: body._tag === "Uint8Array" ? body.contentType : undefined,
			lines: text
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => parseLine(line)),
		})
		return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })))
	})
	return { posts, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

// Explicit config so nothing depends on ambient env; interval off so tests
// drive flushes themselves.
const config = {
	serviceName: "billing",
	endpoint: "https://ingest.test/",
	ingestKey: "secret",
	flushInterval: 0,
} as const

const withEvents = <A, E>(
	cfg: Parameters<typeof make>[0],
	httpLayer: Layer.Layer<HttpClient.HttpClient>,
	body: (events: MapleEvents["Service"]) => Effect.Effect<A, E>,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const events = yield* make(cfg).pipe(Effect.provide(httpLayer))
			return yield* body(events)
		}),
	)

describe("MapleEvents (server)", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it.effect("posts one NDJSON line per event with the ingest key and identity fields", () =>
		Effect.gen(function* () {
			const { posts, layer } = stubClient()
			yield* withEvents(config, layer, (events) =>
				Effect.gen(function* () {
					yield* events.track("plan_started", {
						userId: "user_1",
						groupId: "org_1",
						visitorId: "v-1",
						sessionId: "s-1",
						timestamp: new Date("2026-08-17T10:00:00.000Z"),
						url: "https://app.example.com/billing",
						pagePath: "/billing",
						attributes: { plan: "startup", seats: 5, trial: false, dropped: undefined },
					})
					yield* events.track("  padded  ")
					yield* events.flush
				}),
			)

			expect(posts).toHaveLength(1)
			const [batch] = posts
			expect(batch!.url).toBe("https://ingest.test/v1/events")
			expect(batch!.headers.authorization).toBe("Bearer secret")
			expect(batch!.contentType).toBe("application/x-ndjson")
			expect(batch!.lines).toEqual([
				{
					name: "plan_started",
					timestamp: "2026-08-17T10:00:00.000Z",
					source: "server",
					service_name: "billing",
					visitor_id: "v-1",
					user_id: "user_1",
					group_id: "org_1",
					session_id: "s-1",
					url: "https://app.example.com/billing",
					page_path: "/billing",
					attributes: { plan: "startup", seats: "5", trial: "false" },
				},
				expect.objectContaining({
					name: "padded",
					source: "server",
					service_name: "billing",
					visitor_id: "",
					user_id: "",
					group_id: "",
					session_id: "",
					url: "",
					page_path: "",
					attributes: {},
				}),
			])
			expect(typeof batch!.lines[1]!.timestamp).toBe("string")
		}),
	)

	it.effect("batches: nothing is posted until flush, and flush with an empty buffer posts nothing", () =>
		Effect.gen(function* () {
			const { posts, layer } = stubClient()
			yield* withEvents(config, layer, (events) =>
				Effect.gen(function* () {
					yield* events.flush
					expect(posts).toHaveLength(0)
					yield* events.track("a")
					yield* events.track("b")
					yield* events.track("c")
					expect(posts).toHaveLength(0)
					yield* events.flush
					expect(posts).toHaveLength(1)
					expect(posts[0]!.lines.map((line) => line.name)).toEqual(["a", "b", "c"])
					yield* events.flush
					expect(posts).toHaveLength(1)
				}),
			)
		}),
	)

	it.effect("flushes early once maxBatchSize events are buffered", () =>
		Effect.gen(function* () {
			const { posts, layer } = stubClient()
			yield* withEvents({ ...config, maxBatchSize: 2 }, layer, (events) =>
				Effect.gen(function* () {
					yield* events.track("a")
					yield* events.track("b")
					// The size-triggered flush is forked; let it run.
					yield* Effect.yieldNow
					yield* Effect.yieldNow
					expect(posts).toHaveLength(1)
					expect(posts[0]!.lines.map((line) => line.name)).toEqual(["a", "b"])
				}),
			)
		}),
	)

	it.effect("drains the buffer when the scope closes", () =>
		Effect.gen(function* () {
			const { posts, layer } = stubClient()
			const scope = yield* Scope.make()
			const events = yield* make(config).pipe(Effect.provide(layer), Scope.provide(scope))
			yield* events.track("shutdown_event")
			expect(posts).toHaveLength(0)
			yield* Scope.close(scope, undefined as never)
			expect(posts).toHaveLength(1)
			expect(posts[0]!.lines[0]!.name).toBe("shutdown_event")
		}),
	)

	it.effect("never fails the caller: a rejected batch is dropped with a warning", () =>
		Effect.gen(function* () {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			const { posts, layer } = stubClient(401)
			yield* withEvents(config, layer, (events) =>
				Effect.gen(function* () {
					yield* events.track("a")
					yield* events.flush
					yield* events.flush
				}),
			)
			expect(posts).toHaveLength(1)
			expect(warn).toHaveBeenCalledTimes(1)
			expect(String(warn.mock.calls[0]![0])).toContain("401")
		}),
	)

	it.effect("ignores an empty event name and drops events without an ingest key", () =>
		Effect.gen(function* () {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			const { posts, layer } = stubClient()
			yield* withEvents({ ...config, ingestKey: undefined }, layer, (events) =>
				Effect.gen(function* () {
					yield* events.track("   ")
					yield* events.track("real")
					yield* events.flush
				}),
			)
			expect(posts).toHaveLength(0)
			expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
				expect.stringContaining("non-empty event name"),
				expect.stringContaining("no ingest key"),
			])
		}),
	)

	it.effect("is usable as the MapleEvents service", () =>
		Effect.gen(function* () {
			const { posts, layer } = stubClient()
			const serviceLayer = Layer.effect(MapleEvents, make(config)).pipe(Layer.provide(layer))
			yield* MapleEvents.use((events) =>
				Effect.gen(function* () {
					yield* events.track("via_layer", { userId: "u" })
					yield* events.flush
				}),
			).pipe(Effect.provide(serviceLayer))
			expect(posts[0]!.lines[0]).toMatchObject({ name: "via_layer", user_id: "u" })
		}),
	)

	it("makeHandle: fire-and-forget track, flush and dispose over fetch", async () => {
		const bodies: Array<string> = []
		const original = globalThis.fetch
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(
				typeof init?.body === "string"
					? init.body
					: new TextDecoder().decode(init?.body as ArrayBuffer),
			)
			return new Response(null, { status: 200 })
		}) as typeof fetch
		try {
			const handle = makeHandle(config)
			handle.track("signup_completed", { userId: "user_9" })
			await handle.flush()
			expect(bodies).toHaveLength(1)
			expect(JSON.parse(bodies[0]!.trim())).toMatchObject({
				name: "signup_completed",
				user_id: "user_9",
			})
			handle.track("last_one")
			await handle.dispose()
			expect(bodies).toHaveLength(2)
			expect(JSON.parse(bodies[1]!.trim())).toMatchObject({ name: "last_one" })
		} finally {
			globalThis.fetch = original
		}
	})
})
