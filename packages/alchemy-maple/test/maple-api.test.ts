import { Duration, Effect, Fiber, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { describe, expect, it } from "@effect/vitest"
import { MapleApi, MapleApiFromHttpClient } from "../src/MapleApi"
import { isMapleApiResponseError } from "../src/errors"
import { MapleEnvironment } from "../src/MapleEnvironment"

const environment = Layer.succeed(MapleEnvironment, {
	baseUrl: "https://maple.test",
	apiKey: Redacted.make("maple_ak_test"),
})

const errorEnvelope = (overrides: {
	readonly retryable: boolean
	readonly retry_after_seconds?: number
	readonly retry_at?: string
}) => ({
	error: {
		_tag: "@maple/http/errors/ApiKeyNotFoundError",
		type: "not_found_error",
		code: "api_key_not_found",
		title: "API key not found",
		message: "No such API key.",
		recovery: "none",
		...overrides,
	},
})

const retryableErrorEnvelope = (overrides: {
	readonly retry_after_seconds?: number
	readonly retry_at?: string
}) => ({
	error: {
		_tag: "@maple/http/errors/WarehouseUpstreamError",
		type: "api_error",
		code: "warehouse_unavailable",
		title: "Database is temporarily unavailable",
		message: "Retry in a few seconds.",
		retryable: true,
		recovery: "retry",
		...overrides,
	},
})

const clientLayer = (respond: (request: HttpClientRequest.HttpClientRequest) => Response) =>
	Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, respond(request)))),
	)
describe("MapleApi errors", () => {
	it.effect("preserves the complete semantic error body", () => {
		const http = clientLayer(
			() =>
				new Response(JSON.stringify(errorEnvelope({ retryable: false })), {
					status: 404,
					headers: { "content-type": "application/json" },
				}),
		)
		return Effect.gen(function* () {
			const api = yield* MapleApi
			const error = yield* Effect.flip(api.get("/v2/api_keys/key_missing"))
			expect(isMapleApiResponseError(error)).toBe(true)
			if (!isMapleApiResponseError(error)) return
			expect(error.status).toBe(404)
			expect(error._tag).toBe("@maple/http/errors/ApiKeyNotFoundError")
			expect(error.error).toEqual(errorEnvelope({ retryable: false }).error)
		}).pipe(
			Effect.provide(MapleApiFromHttpClient().pipe(Layer.provide(environment), Layer.provide(http))),
		)
	})

	it.effect("retries only when the public body says to retry", () => {
		let attempts = 0
		const http = clientLayer(() => {
			attempts += 1
			return attempts === 1
				? new Response(
						JSON.stringify(retryableErrorEnvelope({ retry_at: "1970-01-01T00:00:00.000Z" })),
						{ status: 503, headers: { "content-type": "application/json" } },
					)
				: new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "content-type": "application/json" },
					})
		})
		return Effect.gen(function* () {
			const api = yield* MapleApi
			expect(yield* api.get("/v2/api_keys/key_retry")).toEqual({ ok: true })
			expect(attempts).toBe(2)
		}).pipe(
			Effect.provide(MapleApiFromHttpClient().pipe(Layer.provide(environment), Layer.provide(http))),
		)
	})

	it.effect("does not automatically replay a retryable mutation", () => {
		let attempts = 0
		const http = clientLayer(() => {
			attempts += 1
			return new Response(JSON.stringify(retryableErrorEnvelope({})), {
				status: 503,
				headers: { "content-type": "application/json" },
			})
		})
		return Effect.gen(function* () {
			const api = yield* MapleApi
			const error = yield* Effect.flip(api.post("/v2/api_keys", { name: "ci" }))
			expect(isMapleApiResponseError(error)).toBe(true)
			expect(attempts).toBe(1)
		}).pipe(
			Effect.provide(MapleApiFromHttpClient().pipe(Layer.provide(environment), Layer.provide(http))),
		)
	})

	it.effect("uses retry_after_seconds before retry_at", () => {
		let attempts = 0
		const http = clientLayer(() => {
			attempts += 1
			return attempts === 1
				? new Response(
						JSON.stringify(
							retryableErrorEnvelope({
								retry_after_seconds: 5,
								retry_at: "1970-01-01T00:00:02.000Z",
							}),
						),
						{ status: 503, headers: { "content-type": "application/json" } },
					)
				: new Response(JSON.stringify({ ok: true }), { status: 200 })
		})
		return Effect.gen(function* () {
			const api = yield* MapleApi
			const fiber = yield* Effect.forkChild(api.get("/v2/api_keys/key_retry"))
			yield* TestClock.adjust(Duration.zero)
			expect(attempts).toBe(1)
			yield* TestClock.adjust(Duration.seconds(2))
			expect(attempts).toBe(1)
			yield* TestClock.adjust(Duration.seconds(3))
			expect(yield* Fiber.join(fiber)).toEqual({ ok: true })
			expect(attempts).toBe(2)
		}).pipe(
			Effect.provide(MapleApiFromHttpClient().pipe(Layer.provide(environment), Layer.provide(http))),
		)
	})

	it.effect("waits until a future retry_at before retrying", () => {
		let attempts = 0
		const http = clientLayer(() => {
			attempts += 1
			return attempts === 1
				? new Response(
						JSON.stringify(retryableErrorEnvelope({ retry_at: "1970-01-01T00:00:05.000Z" })),
						{ status: 503 },
					)
				: new Response(JSON.stringify({ ok: true }), { status: 200 })
		})
		return Effect.gen(function* () {
			const api = yield* MapleApi
			const fiber = yield* Effect.forkChild(api.get("/v2/api_keys/key_retry"))
			yield* TestClock.adjust(Duration.zero)
			expect(attempts).toBe(1)
			yield* TestClock.adjust(Duration.seconds(4))
			expect(attempts).toBe(1)
			yield* TestClock.adjust(Duration.seconds(1))
			expect(yield* Fiber.join(fiber)).toEqual({ ok: true })
			expect(attempts).toBe(2)
		}).pipe(
			Effect.provide(MapleApiFromHttpClient().pipe(Layer.provide(environment), Layer.provide(http))),
		)
	})

	it.effect("stops after six retries", () => {
		let attempts = 0
		const http = clientLayer(() => {
			attempts += 1
			return new Response(
				JSON.stringify(retryableErrorEnvelope({ retry_at: "1970-01-01T00:00:00.000Z" })),
				{ status: 503, headers: { "content-type": "application/json" } },
			)
		})
		return Effect.gen(function* () {
			const api = yield* MapleApi
			const error = yield* Effect.flip(api.get("/v2/api_keys/key_retry"))
			expect(isMapleApiResponseError(error)).toBe(true)
			expect(attempts).toBe(7)
		}).pipe(
			Effect.provide(MapleApiFromHttpClient().pipe(Layer.provide(environment), Layer.provide(http))),
		)
	})

	it.effect("rejects a body whose category does not match its HTTP status", () => {
		const http = clientLayer(
			() =>
				new Response(JSON.stringify(errorEnvelope({ retryable: false })), {
					status: 503,
				}),
		)
		return Effect.gen(function* () {
			const api = yield* MapleApi
			const error = yield* Effect.flip(api.get("/v2/api_keys/key_missing"))
			expect(error._tag).toBe("@maple/alchemy/errors/ProtocolError")
			expect(isMapleApiResponseError(error)).toBe(false)
		}).pipe(
			Effect.provide(MapleApiFromHttpClient().pipe(Layer.provide(environment), Layer.provide(http))),
		)
	})

	it.effect("rejects a not-found tag for the wrong endpoint", () => {
		const wrong = errorEnvelope({ retryable: false })
		wrong.error._tag = "@maple/http/errors/DashboardNotFoundError"
		const http = clientLayer(() => new Response(JSON.stringify(wrong), { status: 404 }))
		return Effect.gen(function* () {
			const api = yield* MapleApi
			const error = yield* Effect.flip(api.get("/v2/api_keys/key_missing"))
			expect(error._tag).toBe("@maple/alchemy/errors/ProtocolError")
		}).pipe(
			Effect.provide(MapleApiFromHttpClient().pipe(Layer.provide(environment), Layer.provide(http))),
		)
	})

	it.effect("rejects a client-side tag masquerading as a server failure", () => {
		const wrong = errorEnvelope({ retryable: false })
		wrong.error._tag = "@maple/alchemy/errors/ProtocolError"
		const http = clientLayer(() => new Response(JSON.stringify(wrong), { status: 404 }))
		return Effect.gen(function* () {
			const api = yield* MapleApi
			const error = yield* Effect.flip(api.get("/v2/api_keys/key_missing"))
			expect(error._tag).toBe("@maple/alchemy/errors/ProtocolError")
			expect(isMapleApiResponseError(error)).toBe(false)
		}).pipe(
			Effect.provide(MapleApiFromHttpClient().pipe(Layer.provide(environment), Layer.provide(http))),
		)
	})
})
