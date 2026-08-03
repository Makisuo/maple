import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, expect, vi } from "vitest"
import { make } from "./flushable.js"

interface FetchCall {
	readonly url: string
	readonly headers: Record<string, string>
	readonly body: unknown
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

// Deterministic config that doesn't depend on ambient env, with the auto-flush
// timer off so tests flush explicitly.
const baseConfig = {
	serviceName: "unit-test",
	serviceNamespace: "unit-test-ns",
	endpoint: "https://collector.test",
	ingestKey: "secret",
	environment: "test",
	autoFlushInterval: false as const,
}

describe("MapleFlush.make (server)", () => {
	let restore: () => void

	afterEach(() => {
		restore?.()
		vi.useRealTimers()
	})

	it("buffers spans and POSTs to /v1/traces with auth + resource attrs on flush", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make(baseConfig)

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op-1"), Effect.provide(telemetry.layer)),
		)
		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op-2"), Effect.provide(telemetry.layer)),
		)

		await telemetry.flush()

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
		expect(attrMap["service.namespace"]).toBe("unit-test-ns")
		expect(attrMap["maple.sdk.type"]).toBe("server")
		// Dual-emit: legacy key for Tinybird MVs + OTel-canonical key.
		expect(attrMap["deployment.environment"]).toBe("test")
		expect(attrMap["deployment.environment.name"]).toBe("test")
		// Per-process UUID, same as the Cloudflare preset.
		expect(attrMap["service.instance.id"]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		)
	})

	it("ships Effect log records to /v1/logs with severity + body", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make(baseConfig)

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* Effect.logInfo("hello world")
				yield* Effect.logError("kaboom")
			}).pipe(Effect.provide(telemetry.layer)),
		)

		await telemetry.flush()

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

	it.effect("ends in-flight spans when an outer Effect.timeoutOrElse interrupts the work", () =>
		Effect.gen(function* () {
			const { calls, restore: r } = setupFetch()
			restore = r
			const telemetry = make(baseConfig)

			const slowWork = Effect.sleep(Duration.seconds(10)).pipe(Effect.withSpan("slow-op"))
			const wrapped = Effect.timeoutOrElse(slowWork, {
				duration: Duration.millis(20),
				orElse: () => Effect.void,
			})

			const fiber = yield* Effect.forkChild(Effect.provide(wrapped, telemetry.layer))
			yield* TestClock.adjust(Duration.millis(20))
			yield* Fiber.join(fiber)

			yield* Effect.promise(() => telemetry.flush())

			const traceCall = calls.find((c) => c.url.endsWith("/v1/traces"))
			expect(
				traceCall,
				"expected traces to be POSTed even though the inner span was interrupted",
			).toBeDefined()
			const body = traceCall!.body as {
				resourceSpans: Array<{
					scopeSpans: Array<{
						spans: Array<{
							name: string
							status: { code: number; message?: string }
							attributes: Array<{ key: string; value: { boolValue?: boolean } }>
						}>
					}>
				}>
			}
			const span = body.resourceSpans[0].scopeSpans[0].spans.find((s) => s.name === "slow-op")
			expect(span, "slow-op span should be present in the export").toBeDefined()
			assert.strictEqual(span!.status.code, 1)
			assert.strictEqual(span!.status.message, "Interrupted")
			const interrupted = span!.attributes.find((a) => a.key === "status.interrupted")
			assert.strictEqual(interrupted?.value.boolValue, true)
		}),
	)

	it("second flush is a no-op when buffer is empty", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make(baseConfig)

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op-once"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()
		const firstCount = calls.length
		await telemetry.flush()
		expect(calls.length).toBe(firstCount)
	})

	it("runs in no-op mode when no ingest key is configured", async () => {
		const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
		const { calls, restore: r } = setupFetch()
		restore = () => {
			r()
			consoleInfoSpy.mockRestore()
		}
		// No `ingestKey` and no endpoint → resolveResource yields no key → no-op.
		const telemetry = make({ serviceName: "unit-test", autoFlushInterval: false })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		expect(calls.length).toBe(0)
		expect(consoleInfoSpy).toHaveBeenCalledTimes(1)
		expect(consoleInfoSpy.mock.calls[0][0]).toContain("no ingest key configured")

		// One-shot: a second flush stays silent.
		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op-2"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()
		expect(calls.length).toBe(0)
		expect(consoleInfoSpy).toHaveBeenCalledTimes(1)
	})

	it("survives a failing collector — disables the signal for a cooldown", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { calls, restore: r } = setupFetch(() => new Response(null, { status: 500 }))
		restore = () => {
			r()
			consoleErrorSpy.mockRestore()
		}
		const telemetry = make(baseConfig)

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush() // fails, sets cooldown
		const failedCount = calls.length

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op-2"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush() // within cooldown, no POST
		expect(calls.length).toBe(failedCount)
		expect(consoleErrorSpy).toHaveBeenCalled()
	})

	it("auto-flushes on the interval without a manual flush, and dispose() stops the timer", async () => {
		vi.useFakeTimers()
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make({ ...baseConfig, autoFlushInterval: 5_000 })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("timed-op"), Effect.provide(telemetry.layer)),
		)

		// No manual flush — advance past the interval and let async work settle.
		await vi.advanceTimersByTimeAsync(5_000)
		expect(calls.some((c) => c.url.endsWith("/v1/traces"))).toBe(true)
		const afterAuto = calls.length

		// dispose() clears the timer (its final flush is a no-op — buffer drained).
		await telemetry.dispose()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(calls.length).toBe(afterAuto)
	})

	it("drops spans whose name matches a dropSpanNames prefix", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make({ ...baseConfig, dropSpanNames: ["internal."] })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(
				Effect.withSpan("internal.healthcheck"),
				Effect.provide(telemetry.layer),
			),
		)
		await Effect.runPromise(
			Effect.succeed(undefined).pipe(
				Effect.withSpan("public.request"),
				Effect.provide(telemetry.layer),
			),
		)
		await telemetry.flush()

		const traceCall = calls.find((c) => c.url.endsWith("/v1/traces"))
		expect(traceCall).toBeDefined()
		const names = (
			traceCall!.body as {
				resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>
			}
		).resourceSpans[0].scopeSpans[0].spans.map((s) => s.name)
		expect(names).toEqual(["public.request"])
	})

	it("appends custom tracesPath / logsPath to the endpoint", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make({
			...baseConfig,
			tracesPath: "/otlp/traces",
			logsPath: "/otlp/logs",
		})

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* Effect.logInfo("hi")
			}).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		expect(calls.some((c) => c.url === "https://collector.test/otlp/traces")).toBe(true)
		expect(calls.some((c) => c.url === "https://collector.test/otlp/logs")).toBe(true)
	})

	it("normalizes a trailing slash on the endpoint (no double slash)", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make({ ...baseConfig, endpoint: "https://collector.test/" })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		const traceCall = calls.find((c) => c.url.includes("/v1/traces"))
		expect(traceCall?.url).toBe("https://collector.test/v1/traces")
	})

	it("does not start an auto-flush timer when autoFlushInterval is false", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(() => 0 as never)
		restore = () => setIntervalSpy.mockRestore()
		make({ ...baseConfig, autoFlushInterval: false })
		expect(setIntervalSpy).not.toHaveBeenCalled()
	})

	it("links log records to the active span and maps log severity", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make(baseConfig)

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* Effect.logInfo("inside the span")
			}).pipe(Effect.withSpan("parent-span"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		const span = (
			calls.find((c) => c.url.endsWith("/v1/traces"))!.body as {
				resourceSpans: Array<{
					scopeSpans: Array<{ spans: Array<{ traceId: string; spanId: string }> }>
				}>
			}
		).resourceSpans[0].scopeSpans[0].spans[0]

		const record = (
			calls.find((c) => c.url.endsWith("/v1/logs"))!.body as {
				resourceLogs: Array<{
					scopeLogs: Array<{
						logRecords: Array<{ traceId?: string; spanId?: string; severityNumber?: number }>
					}>
				}>
			}
		).resourceLogs[0].scopeLogs[0].logRecords[0]

		// The log carries the enclosing span's trace + span ids…
		expect(record.traceId).toBe(span.traceId)
		expect(record.spanId).toBe(span.spanId)
		// …and Info maps to OTLP severity number 9.
		expect(record.severityNumber).toBe(9)
	})
})
