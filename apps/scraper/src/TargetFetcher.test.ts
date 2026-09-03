import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Exit, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { InternalScrapeTarget } from "@maple/domain/http"
import { endedSpansNamed, makeCapturingTracer } from "./testing/capturing-tracer"
import { parseRetryAfterSeconds, scrapeTimeoutMs, TargetFetcher } from "./TargetFetcher"

const decodeTarget = Schema.decodeUnknownSync(InternalScrapeTarget)

const mkTarget = (
	overrides: Partial<{
		targetType: "prometheus" | "planetscale"
		scrapeUrl: string
		authHeaders: Record<string, string>
		scrapeIntervalSeconds: number
	}> = {},
): InternalScrapeTarget =>
	decodeTarget({
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		orgId: "org_test",
		name: "node",
		serviceName: null,
		targetType: overrides.targetType ?? "prometheus",
		url: "https://node.example.com/metrics",
		scrapeUrl: overrides.scrapeUrl ?? "https://node.example.com/metrics",
		authHeaders: overrides.authHeaders ?? {},
		subTargetKey: null,
		scrapeIntervalSeconds: overrides.scrapeIntervalSeconds ?? 15,
		labels: {},
		ingestKey: "maple_pk_test",
	})

interface RecordedRequest {
	url: string
	headers: Record<string, string>
}

const stubFetch = (
	recorded: Array<RecordedRequest>,
	respond: (init?: RequestInit) => Response | Promise<Response>,
): typeof globalThis.fetch =>
	(async (input: string | URL | Request, init?: RequestInit) => {
		const headers: Record<string, string> = {}
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value
		})
		recorded.push({ url: input instanceof Request ? input.url : String(input), headers })
		return respond(init)
	}) as typeof globalThis.fetch

describe("TargetFetcher", () => {
	it.effect("GETs the scrape url with the target's auth headers and passes the status through", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const fetcher = yield* TargetFetcher
			const response = yield* fetcher
				.fetch(mkTarget({ authHeaders: { Authorization: "Bearer stored-token" } }))
				.pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						stubFetch(
							recorded,
							() =>
								new Response("# TYPE up gauge\nup 1\n", {
									status: 503,
									headers: { "retry-after": "120" },
								}),
						),
					),
				)

			assert.strictEqual(recorded[0]?.url, "https://node.example.com/metrics")
			assert.strictEqual(recorded[0]?.headers.authorization, "Bearer stored-token")
			assert.strictEqual(response.status, 503)
			assert.include(response.body, "up 1")
			assert.strictEqual(response.retryAfterSeconds, 120)
		}).pipe(Effect.provide(TargetFetcher.layer)),
	)

	it.effect("rejects a private-range scrape url before any request is made", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const fetcher = yield* TargetFetcher
			const error = yield* fetcher
				.fetch(mkTarget({ scrapeUrl: "http://169.254.169.254/latest/meta-data/" }))
				.pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						stubFetch(recorded, () => new Response("secret", { status: 200 })),
					),
					Effect.flip,
				)

			assert.strictEqual(error.reason, "invalid_url")
			assert.include(error.message, "url rejected")
			assert.lengthOf(recorded, 0)
		}).pipe(Effect.provide(TargetFetcher.layer)),
	)

	it.effect("drops the Authorization header when a redirect leaves the origin", () =>
		Effect.gen(function* () {
			const recorded: Array<RecordedRequest> = []
			const fetcher = yield* TargetFetcher
			const response = yield* fetcher
				.fetch(mkTarget({ authHeaders: { Authorization: "Bearer stored-token" } }))
				.pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						stubFetch(recorded, () =>
							recorded.length === 1
								? new Response(null, {
										status: 302,
										headers: { location: "https://elsewhere.example.org/metrics" },
									})
								: new Response("up 1\n", { status: 200 }),
						),
					),
				)

			assert.strictEqual(response.status, 200)
			assert.strictEqual(recorded[0]?.headers.authorization, "Bearer stored-token")
			assert.strictEqual(recorded[1]?.url, "https://elsewhere.example.org/metrics")
			assert.isUndefined(recorded[1]?.headers.authorization)
		}).pipe(Effect.provide(TargetFetcher.layer)),
	)

	it.effect("classifies a transport failure without backing the failure's text out of the target", () =>
		Effect.gen(function* () {
			const fetcher = yield* TargetFetcher
			const error = yield* fetcher.fetch(mkTarget()).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch([], () => Promise.reject(new TypeError("connection refused"))),
				),
				Effect.flip,
			)

			assert.strictEqual(error.reason, "transport")
			assert.strictEqual(error.message, "request failed: connection refused")
		}).pipe(Effect.provide(TargetFetcher.layer)),
	)

	it.effect("times out at the interval-derived ceiling and aborts the request", () =>
		Effect.gen(function* () {
			let aborted = false
			const fetcher = yield* TargetFetcher
			const fiber = yield* fetcher.fetch(mkTarget({ scrapeIntervalSeconds: 30 })).pipe(
				Effect.provideService(
					FetchHttpClient.Fetch,
					stubFetch(
						[],
						(init) =>
							new Promise<Response>((_resolve, reject) => {
								init?.signal?.addEventListener("abort", () => {
									aborted = true
									reject(new Error("aborted"))
								})
							}),
					),
				),
				Effect.exit,
				Effect.forkChild,
			)

			// 30s interval → 29s ceiling: nothing at 28s, failure at 29s.
			yield* TestClock.adjust(Duration.seconds(28))
			assert.isFalse(aborted)
			yield* TestClock.adjust(Duration.seconds(1))
			const exit = yield* Fiber.join(fiber)

			assert.isTrue(Exit.isFailure(exit))
			if (!Exit.isFailure(exit)) return
			assert.isTrue(aborted)
			assert.include(String(exit.cause), "request timed out")
		}).pipe(Effect.provide(TargetFetcher.layer)),
	)

	it.effect("annotates the client span with host and path but never the signed query", () =>
		Effect.gen(function* () {
			const tracer = makeCapturingTracer()
			const fetcher = yield* TargetFetcher
			yield* fetcher
				.fetch(
					mkTarget({
						targetType: "planetscale",
						scrapeUrl: "https://branch.metrics.psdb.cloud/metrics?sig=SECRET&exp=123",
					}),
				)
				.pipe(
					Effect.provideService(
						FetchHttpClient.Fetch,
						stubFetch([], () => new Response("up 1\n", { status: 200 })),
					),
					Effect.provide(tracer.layer),
				)

			const [span] = endedSpansNamed(tracer.ended, "scraper.fetch_target")
			assert.isDefined(span)
			if (!span) return
			assert.strictEqual(span.attributes.get("peer.service"), "planetscale-metrics")
			assert.strictEqual(span.attributes.get("maple.scrape.target_type"), "planetscale")
			assert.strictEqual(span.attributes.get("server.address"), "branch.metrics.psdb.cloud")
			assert.strictEqual(span.attributes.get("url.path"), "/metrics")
			assert.strictEqual(span.attributes.get("http.response.status_code"), 200)
			for (const value of span.attributes.values()) {
				assert.notInclude(String(value), "SECRET")
			}
		}).pipe(Effect.provide(TargetFetcher.layer)),
	)
})

describe("scrapeTimeoutMs", () => {
	it("stays one second under the interval, floored at 1s and capped at 60s", () => {
		assert.strictEqual(scrapeTimeoutMs(5), 4_000)
		assert.strictEqual(scrapeTimeoutMs(1), 1_000)
		assert.strictEqual(scrapeTimeoutMs(300), 60_000)
	})
})

describe("parseRetryAfterSeconds", () => {
	it("honors delta-seconds and ignores HTTP dates and garbage", () => {
		assert.strictEqual(parseRetryAfterSeconds("120"), 120)
		assert.strictEqual(parseRetryAfterSeconds(" 0 "), 0)
		assert.isNull(parseRetryAfterSeconds("Wed, 21 Oct 2015 07:28:00 GMT"))
		assert.isNull(parseRetryAfterSeconds("-5"))
		assert.isNull(parseRetryAfterSeconds(null))
	})
})
