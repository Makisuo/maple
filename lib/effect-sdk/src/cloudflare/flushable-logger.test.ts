import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { makeFlushableLogger, noopLogger } from "./flushable-logger.js"

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

describe("makeFlushableLogger", () => {
	it("noopLogger.flush is a no-op effect", async () => {
		const result = await Effect.runPromise(
			noopLogger.flush.pipe(
				Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.die("unreachable"))),
			),
		)
		expect(result).toBeUndefined()
	})

	it("buffers Effect log records and POSTs them on flush in OTLP-logs shape", async () => {
		const logger = makeFlushableLogger({
			url: "https://collector.test/v1/logs",
			resource: { serviceName: "unit-test" },
			headers: { authorization: "Bearer secret" },
		})

		const program = Effect.gen(function* () {
			const { client, captures } = yield* makeCapturingClient(200)

			yield* Effect.logInfo("hello world").pipe(Effect.provide(logger.layer))
			yield* Effect.logError("kaboom").pipe(Effect.provide(logger.layer))

			yield* logger.flush.pipe(Effect.provideService(HttpClient.HttpClient, client))

			return yield* Ref.get(captures)
		})

		const captured = await Effect.runPromise(program)
		expect(captured).toHaveLength(1)
		expect(captured[0].url).toBe("https://collector.test/v1/logs")
		expect(captured[0].headers.authorization).toBe("Bearer secret")
		const body = JSON.parse(captured[0].bodyText)
		const logRecords = body.resourceLogs[0].scopeLogs[0].logRecords
		expect(logRecords).toHaveLength(2)
		expect(logRecords[0].severityText).toBe("Info")
		expect(logRecords[1].severityText).toBe("Error")
		expect(logRecords[0].body.stringValue).toBe("hello world")
	})

	it("clears buffer on success — second flush is a no-op", async () => {
		const logger = makeFlushableLogger({
			url: "https://collector.test/v1/logs",
			resource: { serviceName: "unit-test" },
		})

		const program = Effect.gen(function* () {
			const { client, captures } = yield* makeCapturingClient(200)
			const provideClient = Layer.succeed(HttpClient.HttpClient, client)

			yield* Effect.logInfo("just one").pipe(Effect.provide(logger.layer))
			yield* logger.flush.pipe(Effect.provide(provideClient))
			yield* logger.flush.pipe(Effect.provide(provideClient))

			return yield* Ref.get(captures)
		})

		const captured = await Effect.runPromise(program)
		expect(captured).toHaveLength(1)
	})

	it("disables further exports after a failed flush (cooldown)", async () => {
		const logger = makeFlushableLogger({
			url: "https://collector.test/v1/logs",
			resource: { serviceName: "unit-test" },
		})

		const program = Effect.gen(function* () {
			const { client, captures } = yield* makeCapturingClient(500)
			const provideClient = Layer.succeed(HttpClient.HttpClient, client)

			yield* Effect.logInfo("first").pipe(Effect.provide(logger.layer))
			yield* logger.flush.pipe(Effect.provide(provideClient))

			yield* Effect.logInfo("during-cooldown").pipe(Effect.provide(logger.layer))
			yield* logger.flush.pipe(Effect.provide(provideClient))

			return yield* Ref.get(captures)
		})

		const captured = await Effect.runPromise(program)
		const second = captured[1]
		if (second) {
			const body = JSON.parse(second.bodyText)
			const records = body.resourceLogs[0].scopeLogs[0].logRecords
			expect(records.map((r: { body: { stringValue?: string } }) => r.body.stringValue)).not.toContain(
				"during-cooldown",
			)
		}
	})
})
