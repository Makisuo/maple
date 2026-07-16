import { describe, it } from "@effect/vitest"
import { Effect, Fiber, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { deepStrictEqual, match, ok, strictEqual } from "node:assert"
import { makeRemoteWarehouseExecutorShape } from "../src/core/remote-executor"

describe("remote warehouse executor", () => {
	it.effect("sends scoped credentials and decodes rows", () =>
		Effect.gen(function* () {
			let request: Request | undefined
			let suppliedSignal: AbortSignal | undefined
			const fetchStub: typeof globalThis.fetch = async (input, init) => {
				suppliedSignal = init?.signal ?? undefined
				request = new Request(input, init)
				return Response.json({ data: [{ serviceName: "api" }] })
			}
			const executor = makeRemoteWarehouseExecutorShape(
				"https://api.maple.test/",
				Redacted.make("secret-token"),
				"org_test",
			)

			const result = yield* executor
				.query<{ serviceName: string }>("services", { limit: 10 })
				.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub))

			deepStrictEqual(result, { data: [{ serviceName: "api" }] })
			strictEqual(request?.url, "https://api.maple.test/api/tinybird/query")
			strictEqual(request?.headers.get("authorization"), "Bearer secret-token")
			const body = yield* Effect.promise(() => request!.json())
			deepStrictEqual(body, { pipe: "services", params: { limit: 10 } })
			ok(suppliedSignal instanceof AbortSignal)
		}),
	)

	it.effect("maps non-success responses to a warehouse query error", () =>
		Effect.gen(function* () {
			const fetchStub: typeof globalThis.fetch = async () =>
				new Response("upstream unavailable", { status: 503 })
			const executor = makeRemoteWarehouseExecutorShape(
				"https://api.maple.test",
				Redacted.make("secret-token"),
				"org_test",
			)

			const error = yield* executor
				.query("services", {})
				.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub), Effect.flip)

			strictEqual(error._tag, "@maple/http/errors/WarehouseQueryError")
			match(error.message, /HTTP 503: upstream unavailable/)
		}),
	)

	it.effect("rejects a successful response with a malformed data envelope", () =>
		Effect.gen(function* () {
			const fetchStub: typeof globalThis.fetch = async () => Response.json({ error: "drift" })
			const executor = makeRemoteWarehouseExecutorShape(
				"https://api.maple.test",
				Redacted.make("secret-token"),
				"org_test",
			)

			const error = yield* executor
				.query("services", {})
				.pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub), Effect.flip)

			strictEqual(error._tag, "@maple/http/errors/WarehouseQueryError")
			match(error.message, /response was invalid/)
		}),
	)

	it.effect("aborts the in-flight request when the query fiber is interrupted", () =>
		Effect.gen(function* () {
			let signal: AbortSignal | undefined
			let markStarted!: () => void
			const started = new Promise<void>((resolve) => {
				markStarted = resolve
			})
			const fetchStub: typeof globalThis.fetch = (_input, init) =>
				new Promise((_resolve, reject) => {
					signal = init?.signal ?? undefined
					markStarted()
					signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
				})
			const executor = makeRemoteWarehouseExecutorShape(
				"https://api.maple.test",
				Redacted.make("secret-token"),
				"org_test",
			)
			const fiber = yield* Effect.forkChild(
				executor.query("services", {}).pipe(Effect.provideService(FetchHttpClient.Fetch, fetchStub)),
				{ startImmediately: true },
			)

			yield* Effect.promise(() => started)
			yield* Fiber.interrupt(fiber)

			strictEqual(signal?.aborted, true)
		}),
	)
})
