import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { makeFlushableTracer, noopTracer } from "./flushable-tracer.js"

interface CapturedRequest {
	readonly url: string
	readonly headers: Record<string, string>
	readonly bodyText: string
}

const makeCapturingClient = (status = 200) =>
	Effect.gen(function* () {
		const captures = yield* Ref.make<Array<CapturedRequest>>([])
		const client = HttpClient.make((request) =>
			Effect.gen(function* () {
				const bodyText =
					request.body._tag === "Uint8Array"
						? new TextDecoder().decode(request.body.body)
						: request.body._tag === "Raw" && typeof request.body.body === "string"
							? request.body.body
							: ""
				yield* Ref.update(captures, (xs) => [
					...xs,
					{ url: request.url, headers: { ...request.headers }, bodyText },
				])
				return HttpClientResponse.fromWeb(request, new Response(null, { status }))
			}),
		)
		return { client, captures } as const
	})

describe("makeFlushableTracer", () => {
	it("noopTracer.flush is a no-op effect", async () => {
		const result = await Effect.runPromise(
			noopTracer.flush.pipe(
				Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.die("unreachable"))),
			),
		)
		expect(result).toBeUndefined()
	})

	it("buffers spans and POSTs them on flush", async () => {
		const tracer = makeFlushableTracer({
			url: "https://collector.test/v1/traces",
			resource: { serviceName: "unit-test" },
			headers: { authorization: "Bearer secret" },
		})

		const program = Effect.gen(function* () {
			const { client, captures } = yield* makeCapturingClient(200)

			yield* Effect.succeed(undefined).pipe(
				Effect.withSpan("op-1"),
				Effect.provide(tracer.layer),
			)
			yield* Effect.succeed(undefined).pipe(
				Effect.withSpan("op-2"),
				Effect.provide(tracer.layer),
			)

			yield* tracer.flush.pipe(Effect.provideService(HttpClient.HttpClient, client))

			return yield* Ref.get(captures)
		})

		const captured = await Effect.runPromise(program)
		expect(captured).toHaveLength(1)
		expect(captured[0].url).toBe("https://collector.test/v1/traces")
		expect(captured[0].headers.authorization).toBe("Bearer secret")
		const body = JSON.parse(captured[0].bodyText)
		const spans = body.resourceSpans[0].scopeSpans[0].spans
		expect(spans).toHaveLength(2)
		expect(spans.map((s: { name: string }) => s.name).sort()).toEqual(["op-1", "op-2"])
	})

	it("clears the buffer after a successful flush so a second flush is a no-op", async () => {
		const tracer = makeFlushableTracer({
			url: "https://collector.test/v1/traces",
			resource: { serviceName: "unit-test" },
		})

		const program = Effect.gen(function* () {
			const { client, captures } = yield* makeCapturingClient(200)
			const provideClient = Layer.succeed(HttpClient.HttpClient, client)

			yield* Effect.succeed(undefined).pipe(
				Effect.withSpan("op-once"),
				Effect.provide(tracer.layer),
			)

			yield* tracer.flush.pipe(Effect.provide(provideClient))
			yield* tracer.flush.pipe(Effect.provide(provideClient))

			return yield* Ref.get(captures)
		})

		const captured = await Effect.runPromise(program)
		expect(captured).toHaveLength(1)
	})

	it("disables further exports for ~60s after a failed flush", async () => {
		const tracer = makeFlushableTracer({
			url: "https://collector.test/v1/traces",
			resource: { serviceName: "unit-test" },
		})

		const program = Effect.gen(function* () {
			const { client, captures } = yield* makeCapturingClient(500)
			const provideClient = Layer.succeed(HttpClient.HttpClient, client)

			yield* Effect.succeed(undefined).pipe(
				Effect.withSpan("op-fails"),
				Effect.provide(tracer.layer),
			)

			yield* tracer.flush.pipe(Effect.provide(provideClient))

			yield* Effect.succeed(undefined).pipe(
				Effect.withSpan("op-while-disabled"),
				Effect.provide(tracer.layer),
			)
			yield* tracer.flush.pipe(Effect.provide(provideClient))

			return yield* Ref.get(captures)
		})

		const captured = await Effect.runPromise(program)
		expect(captured.length).toBeGreaterThanOrEqual(1)
		const second = captured[1]
		if (second) {
			const body = JSON.parse(second.bodyText)
			const spans = body.resourceSpans[0].scopeSpans[0].spans
			expect(spans.map((s: { name: string }) => s.name)).not.toContain("op-while-disabled")
		}
	})
})
