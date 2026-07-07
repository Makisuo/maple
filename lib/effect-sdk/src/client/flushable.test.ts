import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, expect, vi } from "vitest"
import { make } from "./flushable.js"

interface FetchCall {
	readonly url: string
	readonly headers: Record<string, string>
	readonly body: unknown
	readonly keepalive: boolean | undefined
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
		calls.push({ url, headers, body, keepalive: init?.keepalive })
		return responder(url)
	}) as typeof fetch
	return { calls, restore: () => void (globalThis.fetch = original) }
}

// Minimal DOM event shim — vitest runs in node, where globalThis isn't an
// EventTarget. Lets us drive `pagehide` / `visibilitychange` without jsdom.
const setupDom = () => {
	const listeners: Record<string, Set<EventListenerOrEventListenerObject>> = {}
	const g = globalThis as Record<string, any>
	const orig = {
		add: g.addEventListener,
		remove: g.removeEventListener,
		document: g.document,
	}
	g.addEventListener = (type: string, fn: EventListenerOrEventListenerObject) => {
		;(listeners[type] ??= new Set()).add(fn)
	}
	g.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject) => {
		listeners[type]?.delete(fn)
	}
	const doc = { visibilityState: "visible" as "visible" | "hidden" }
	g.document = doc
	return {
		fire: (type: string) => {
			for (const fn of listeners[type] ?? []) (fn as () => void)()
		},
		setHidden: () => {
			doc.visibilityState = "hidden"
		},
		listenerCount: (type: string) => listeners[type]?.size ?? 0,
		restore: () => {
			g.addEventListener = orig.add
			g.removeEventListener = orig.remove
			g.document = orig.document
		},
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const baseConfig = {
	serviceName: "unit-test",
	endpoint: "https://collector.test",
	ingestKey: "secret",
	environment: "test",
	autoFlushInterval: false as const,
	flushOnUnload: false as const,
}

describe("MapleFlush.make (client)", () => {
	let restore: () => void

	afterEach(() => {
		restore?.()
		vi.useRealTimers()
	})

	it("POSTs to /v1/traces with keepalive + client resource attrs", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make(baseConfig)

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op-1"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		const traceCall = calls.find((c) => c.url.endsWith("/v1/traces"))
		expect(traceCall).toBeDefined()
		expect(traceCall!.url).toBe("https://collector.test/v1/traces")
		expect(traceCall!.headers.authorization).toBe("Bearer secret")
		// Must use fetch(keepalive), not sendBeacon — see flushable.ts header.
		expect(traceCall!.keepalive).toBe(true)
		const body = traceCall!.body as {
			resourceSpans: Array<{
				resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }
				scopeSpans: Array<{ spans: Array<{ name: string }> }>
			}>
		}
		expect(body.resourceSpans[0].scopeSpans[0].spans.map((s) => s.name)).toEqual(["op-1"])
		const attrs = body.resourceSpans[0].resource.attributes
		const attrMap = Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]))
		expect(attrMap["service.name"]).toBe("unit-test")
		expect(attrMap["maple.sdk.type"]).toBe("client")
		expect(attrMap["deployment.environment"]).toBe("test")
		expect(attrMap["deployment.environment.name"]).toBe("test")
	})

	it("captures browser navigator + Intl resource attributes", async () => {
		const { calls, restore: rf } = setupFetch()
		// `navigator` is a getter-only global in modern Node — stubGlobal handles it.
		vi.stubGlobal("navigator", { userAgent: "TestAgent/1.0", language: "en-GB" })
		restore = () => {
			rf()
			vi.unstubAllGlobals()
		}
		const telemetry = make(baseConfig)

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		const traceCall = calls.find((c) => c.url.endsWith("/v1/traces"))!
		const attrs = (
			traceCall.body as {
				resourceSpans: Array<{
					resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }
				}>
			}
		).resourceSpans[0].resource.attributes
		const attrMap = Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]))
		expect(attrMap["browser.user_agent"]).toBe("TestAgent/1.0")
		expect(attrMap["browser.language"]).toBe("en-GB")
		// Intl is always present in node/browsers; just assert it's a non-empty string.
		expect(typeof attrMap["browser.timezone"]).toBe("string")
	})

	it("links the active replay session: records the trace id + stamps session.id", async () => {
		const { calls, restore: rf } = setupFetch()
		const g = globalThis as Record<string, any>
		const recordTraceId = vi.fn()
		g.__MAPLE_BROWSER_SESSION__ = { sessionId: "sess-123", recordTraceId }
		restore = () => {
			rf()
			delete g.__MAPLE_BROWSER_SESSION__
		}
		const telemetry = make(baseConfig)

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		expect(recordTraceId).toHaveBeenCalledTimes(1)
		expect(recordTraceId.mock.calls[0][0]).toMatch(/^[0-9a-f]{32}$/i)

		const traceCall = calls.find((c) => c.url.endsWith("/v1/traces"))!
		const span = (
			traceCall.body as {
				resourceSpans: Array<{
					scopeSpans: Array<{
						spans: Array<{ attributes: Array<{ key: string; value: { stringValue?: string } }> }>
					}>
				}>
			}
		).resourceSpans[0].scopeSpans[0].spans[0]
		const sessionAttr = span.attributes.find((a) => a.key === "session.id")
		expect(sessionAttr?.value.stringValue).toBe("sess-123")
	})

	it("stamps session.id from the self-managed session when no sink is published", async () => {
		const { calls, restore: rf } = setupFetch()
		// Standalone: no @maple-dev/browser sink, just a browser-like window with
		// sessionStorage. The bundled @maple/browser-session core must mint a
		// session and stamp its id on every span.
		const store = new Map<string, string>()
		vi.stubGlobal("window", {
			sessionStorage: {
				getItem: (k: string) => store.get(k) ?? null,
				setItem: (k: string, v: string) => void store.set(k, v),
			},
		})
		restore = () => {
			rf()
			vi.unstubAllGlobals()
		}
		const telemetry = make(baseConfig)

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op-a"), Effect.provide(telemetry.layer)),
		)
		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op-b"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		const stored = JSON.parse(store.get("maple.session")!) as { id: string }
		const traceCall = calls.find((c) => c.url.endsWith("/v1/traces"))!
		const spans = (
			traceCall.body as {
				resourceSpans: Array<{
					scopeSpans: Array<{
						spans: Array<{ attributes: Array<{ key: string; value: { stringValue?: string } }> }>
					}>
				}>
			}
		).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans))
		expect(spans.length).toBeGreaterThanOrEqual(2)
		for (const span of spans) {
			const sessionAttr = span.attributes.find((a) => a.key === "session.id")
			expect(sessionAttr?.value.stringValue).toBe(stored.id)
		}
	})

	it("flushes on pagehide and dispose() removes the unload listeners", async () => {
		const { calls, restore: rf } = setupFetch()
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)

		expect(dom.listenerCount("pagehide")).toBe(1)
		// No manual flush — the unload handler should do it.
		dom.fire("pagehide")
		await tick()
		expect(calls.some((c) => c.url.endsWith("/v1/traces"))).toBe(true)

		await telemetry.dispose()
		expect(dom.listenerCount("pagehide")).toBe(0)
		expect(dom.listenerCount("visibilitychange")).toBe(0)
	})

	it("auto-flushes on the interval, and dispose() stops the timer", async () => {
		vi.useFakeTimers()
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make({ ...baseConfig, autoFlushInterval: 5_000 })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("timed-op"), Effect.provide(telemetry.layer)),
		)

		await vi.advanceTimersByTimeAsync(5_000)
		expect(calls.some((c) => c.url.endsWith("/v1/traces"))).toBe(true)
		const afterAuto = calls.length

		await telemetry.dispose()
		await vi.advanceTimersByTimeAsync(10_000)
		expect(calls.length).toBe(afterAuto)
	})

	it("runs in no-op mode when no ingest key is configured", async () => {
		const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
		const { calls, restore: rf } = setupFetch()
		restore = () => {
			rf()
			consoleInfoSpy.mockRestore()
		}
		const telemetry = make({
			serviceName: "unit-test",
			endpoint: "https://collector.test",
			autoFlushInterval: false,
			flushOnUnload: false,
		})

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)
		await telemetry.flush()

		expect(calls.length).toBe(0)
		expect(consoleInfoSpy).toHaveBeenCalledTimes(1)
		expect(consoleInfoSpy.mock.calls[0][0]).toContain("no ingest key configured")
	})

	it("flushes on visibilitychange only when the document is hidden", async () => {
		const { calls, restore: rf } = setupFetch()
		const dom = setupDom()
		restore = () => {
			rf()
			dom.restore()
		}
		const telemetry = make({ ...baseConfig, flushOnUnload: true })

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("op"), Effect.provide(telemetry.layer)),
		)

		// Still visible → the handler must not flush.
		dom.fire("visibilitychange")
		await tick()
		expect(calls.some((c) => c.url.endsWith("/v1/traces"))).toBe(false)

		// Hidden → flush the tail before the tab is backgrounded.
		dom.setHidden()
		dom.fire("visibilitychange")
		await tick()
		expect(calls.some((c) => c.url.endsWith("/v1/traces"))).toBe(true)
	})

	it("registers no unload listeners when flushOnUnload is false", () => {
		const dom = setupDom()
		restore = dom.restore
		make({ ...baseConfig, flushOnUnload: false })
		expect(dom.listenerCount("pagehide")).toBe(0)
		expect(dom.listenerCount("visibilitychange")).toBe(0)
	})

	it("dispose() flushes buffered spans even without a manual flush", async () => {
		const { calls, restore: r } = setupFetch()
		restore = r
		const telemetry = make(baseConfig) // autoFlushInterval + flushOnUnload both off

		await Effect.runPromise(
			Effect.succeed(undefined).pipe(Effect.withSpan("late-op"), Effect.provide(telemetry.layer)),
		)
		// No manual flush, no timer, no unload event — dispose must still drain.
		expect(calls.length).toBe(0)
		await telemetry.dispose()
		expect(calls.some((c) => c.url.endsWith("/v1/traces"))).toBe(true)
	})
})
