// @vitest-environment jsdom
// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import {
	INVALID_SPAN_CONTEXT,
	type Span as ApiSpan,
	trace,
	type Tracer,
	type TracerProvider,
} from "@opentelemetry/api"
import type { ReadableSpan, Span } from "@opentelemetry/sdk-trace-base"
import { afterEach, describe, expect, it, vi } from "vitest"

// Capture what the batch processor actually hands to the exporter, so the
// unload flush can be asserted on exported spans rather than on a spy.
const exported: ReadableSpan[] = []
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
	OTLPTraceExporter: class {
		export(spans: ReadableSpan[], callback: (result: { code: number }) => void): void {
			exported.push(...spans)
			callback({ code: 0 })
		}
		forceFlush(): Promise<void> {
			return Promise.resolve()
		}
		shutdown(): Promise<void> {
			return Promise.resolve()
		}
	},
}))

const { setupTracing, TraceIdCollector } = await import("./tracing")

const CONFIG = {
	ingestKey: "k",
	serviceName: "web",
	endpoint: "https://ingest.test",
	serviceNamespace: undefined,
	serviceVersion: undefined,
	environment: undefined,
	identity: undefined,
	tracingEnabled: true,
	tracingInstrumentFetch: false,
	tracingCaptureErrors: false,
	replayEnabled: false,
	replaySampleRate: 0,
	maskAllInputs: true,
	maskAllText: false,
	persistVisitorId: true,
	crossSubdomainCookie: true,
	cookieDomain: undefined,
	requireConsent: false,
	captureUserEmail: true,
	respectDoNotTrack: false,
}

function makeSpan() {
	const attributes = new Map<string, unknown>()
	const span = {
		spanContext: () => ({ traceId: "0123456789abcdef0123456789abcdef" }),
		setAttribute: (key: string, value: unknown) => {
			attributes.set(key, value)
			return span
		},
	} as Span
	return { attributes, span }
}

describe("TraceIdCollector", () => {
	it("stamps future spans with the current identified user", () => {
		const state: { userId: string | undefined } = { userId: undefined } satisfies {
			userId: string | undefined
		}
		const collector = new TraceIdCollector(() => state.userId)

		const anonymous = makeSpan()
		collector.onStart(anonymous.span)
		expect(anonymous.attributes.get("user.id")).toBeUndefined()

		state.userId = "user_123"
		const identified = makeSpan()
		collector.onStart(identified.span)
		expect(identified.attributes.get("user.id")).toBe("user_123")

		state.userId = undefined
		const cleared = makeSpan()
		collector.onStart(cleared.span)
		expect(cleared.attributes.get("user.id")).toBeUndefined()
	})
})

describe("setupTracing unload flush", () => {
	let shutdown: (() => Promise<void>) | undefined

	afterEach(async () => {
		await shutdown?.()
		shutdown = undefined
		exported.length = 0
		trace.disable()
	})

	const endOneSpan = (): void => {
		trace.getTracer("test").startSpan("click").end()
	}

	it("exports queued spans on pagehide instead of losing them with the tab", async () => {
		shutdown = setupTracing(CONFIG)
		endOneSpan()
		// The batch processor would otherwise sit on this span until its timer
		// fires — a timer the closing tab never reaches.
		expect(exported).toHaveLength(0)

		window.dispatchEvent(new Event("pagehide"))
		await vi.waitFor(() => expect(exported).toHaveLength(1))
		expect(exported[0]?.name).toBe("click")
	})

	it("exports queued spans when the page is hidden, which is the mobile signal", async () => {
		shutdown = setupTracing(CONFIG)
		endOneSpan()

		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
		document.dispatchEvent(new Event("visibilitychange"))
		await vi.waitFor(() => expect(exported).toHaveLength(1))
	})

	it("ignores a visibilitychange back to visible", async () => {
		shutdown = setupTracing(CONFIG)
		endOneSpan()

		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
		document.dispatchEvent(new Event("visibilitychange"))
		await Promise.resolve()
		expect(exported).toHaveLength(0)
	})

	it("exports spans again after init → shutdown → init, without a manual trace.disable", async () => {
		// The global OTel registration is first-write-wins: unless shutdown
		// releases it, the proxy keeps delegating to the shut-down provider and a
		// second SDK session silently exports nothing.
		const first = setupTracing(CONFIG)
		endOneSpan()
		window.dispatchEvent(new Event("pagehide"))
		await vi.waitFor(() => expect(exported).toHaveLength(1))
		await first()

		shutdown = setupTracing(CONFIG)
		endOneSpan()
		window.dispatchEvent(new Event("pagehide"))
		await vi.waitFor(() => expect(exported).toHaveLength(2))
	})

	it("leaves a host app's earlier provider registration alone on shutdown", async () => {
		// A host that registered its own provider owns the globals; losing them
		// (trace.disable) would break the host's tracing, not just ours.
		const hostSpan: ApiSpan = trace.wrapSpanContext(INVALID_SPAN_CONTEXT)
		const hostTracer: Tracer = {
			startSpan: vi.fn(() => hostSpan),
			startActiveSpan: vi.fn(),
		}
		const hostProvider: TracerProvider = { getTracer: () => hostTracer }
		trace.setGlobalTracerProvider(hostProvider)

		const teardown = setupTracing(CONFIG)
		await teardown()

		expect(trace.getTracer("host").startSpan("still-host")).toBeDefined()
		expect(hostTracer.startSpan).toHaveBeenCalledWith("still-host")
	})

	it("removes its listeners on shutdown", async () => {
		const teardown = setupTracing(CONFIG)
		await teardown()

		// A torn-down provider must not still be reachable from a page event.
		expect(() => window.dispatchEvent(new Event("pagehide"))).not.toThrow()
		expect(exported).toHaveLength(0)
	})
})
