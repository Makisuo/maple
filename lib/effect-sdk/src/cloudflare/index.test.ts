import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { make } from "./index.js"

interface FetchCall {
	readonly url: string
	readonly headers: Record<string, string>
	readonly body: unknown
}

const env = {
	MAPLE_ENDPOINT: "https://collector.test",
	MAPLE_INGEST_KEY: "secret",
	MAPLE_ENVIRONMENT: "test",
}

const setupFetch = (responder: (url: string) => Response = () => new Response(null, { status: 200 })) => {
	const calls: Array<FetchCall> = []
	const original = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const headers: Record<string, string> = {}
		const initHeaders = init?.headers
		if (initHeaders instanceof Headers) {
			initHeaders.forEach((v, k) => (headers[k] = v))
		} else if (Array.isArray(initHeaders)) {
			for (const [k, v] of initHeaders) headers[k] = v
		} else if (initHeaders) {
			Object.assign(headers, initHeaders)
		}
		const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined
		calls.push({ url, headers, body })
		return responder(url)
	}) as typeof fetch
	return { calls, restore: () => void (globalThis.fetch = original) }
}

describe("MapleCloudflareSDK.make", () => {
	let restore: () => void

	afterEach(() => {
		restore?.()
	})

	it("buffers spans and POSTs to /v1/traces with auth + resource attrs on flush", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make({ serviceName: "unit-test" })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(
				Effect.withSpan("op-1"),
				Effect.provide(telemetry.layer),
			),
		)
		await Effect.runPromise(
			Effect.succeed(undefined).pipe(
				Effect.withSpan("op-2"),
				Effect.provide(telemetry.layer),
			),
		)

		await telemetry.flush(env)

		const traceCall = calls.find((c) => c.url.endsWith("/v1/traces"))
		expect(traceCall).toBeDefined()
		expect(traceCall!.url).toBe("https://collector.test/v1/traces")
		expect(traceCall!.headers.authorization).toBe("Bearer secret")
		const body = traceCall!.body as {
			resourceSpans: Array<{
				resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }
				scopeSpans: Array<{ spans: Array<{ name: string }> }>
			}>
		}
		const spans = body.resourceSpans[0].scopeSpans[0].spans
		expect(spans.map((s) => s.name).sort()).toEqual(["op-1", "op-2"])
		const attrs = body.resourceSpans[0].resource.attributes
		const attrMap = Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]))
		expect(attrMap["service.name"]).toBe("unit-test")
		expect(attrMap["maple.sdk.type"]).toBe("cloudflare")
		expect(attrMap["deployment.environment"]).toBe("test")
	})

	it("ships Effect log records to /v1/logs with severity + body", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make({ serviceName: "unit-test" })

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* Effect.logInfo("hello world")
				yield* Effect.logError("kaboom")
			}).pipe(Effect.provide(telemetry.layer)),
		)

		await telemetry.flush(env)

		const logCall = calls.find((c) => c.url.endsWith("/v1/logs"))
		expect(logCall).toBeDefined()
		const body = logCall!.body as {
			resourceLogs: Array<{
				scopeLogs: Array<{
					logRecords: Array<{ severityText: string; body: { stringValue?: string } }>
				}>
			}>
		}
		const records = body.resourceLogs[0].scopeLogs[0].logRecords
		expect(records).toHaveLength(2)
		expect(records[0].severityText).toBe("Info")
		expect(records[0].body.stringValue).toBe("hello world")
		expect(records[1].severityText).toBe("Error")
	})

	it("second flush is a no-op when buffer is empty", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make({ serviceName: "unit-test" })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op-once"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush(env)
		const firstCount = calls.length
		await telemetry.flush(env)
		expect(calls.length).toBe(firstCount)
	})

	it("becomes a no-op when no endpoint is configured", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make({ serviceName: "unit-test" })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush({}) // no MAPLE_ENDPOINT

		expect(calls).toHaveLength(0)
	})

	it("explicit config overrides env", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make({
			serviceName: "unit-test",
			endpoint: "https://override.test",
			ingestKey: "override-key",
		})

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush(env)

		const call = calls.find((c) => c.url.endsWith("/v1/traces"))
		expect(call?.url).toBe("https://override.test/v1/traces")
		expect(call?.headers.authorization).toBe("Bearer override-key")
	})

	it("survives a failing collector — flush rejects internally and disables for cooldown", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { calls, restore: r } = setupFetch(() => new Response(null, { status: 500 }))
		restore = () => {
			r()
			consoleErrorSpy.mockRestore()
		}
		const telemetry = make({ serviceName: "unit-test" })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush(env) // first flush — fails, sets cooldown
		const failedCount = calls.length

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op-2"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush(env) // second flush — within cooldown, should be a no-op
		expect(calls.length).toBe(failedCount)
		expect(consoleErrorSpy).toHaveBeenCalled()
	})

	it("layer is stable across calls (same Tracer instance)", () => {
		const telemetry = make({ serviceName: "unit-test" })
		const a = telemetry.layer
		const b = telemetry.layer
		expect(a).toBe(b)
		expect(Layer.isLayer(a)).toBe(true)
	})
})
