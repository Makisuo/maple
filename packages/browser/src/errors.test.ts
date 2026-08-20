// @vitest-environment jsdom
import { assert, beforeEach, describe, it } from "vitest"
import { SpanStatusCode, trace } from "@opentelemetry/api"
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { captureException, setupErrorCapture } from "./errors"

const exporter = new InMemorySpanExporter()

const provider = new BasicTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)],
})
trace.setGlobalTracerProvider(provider)

const exceptionEventOf = (span: ReadableSpan) => span.events.find((event) => event.name === "exception")

beforeEach(() => {
	exporter.reset()
})

describe("captureException", () => {
	it("records an Error span with an exception event", () => {
		captureException(new TypeError("x is not a function"))

		const [span] = exporter.getFinishedSpans()
		assert.strictEqual(span?.name, "exception")
		assert.strictEqual(span?.status.code, SpanStatusCode.ERROR)
		const event = exceptionEventOf(span!)
		assert.strictEqual(event?.attributes?.["exception.type"], "TypeError")
		assert.strictEqual(event?.attributes?.["exception.message"], "x is not a function")
	})

	it("normalizes a non-Error rejection reason into something groupable", () => {
		// A rejected promise can carry anything. It still has to produce one
		// fingerprintable issue rather than throwing inside the handler.
		captureException({ message: "plain object failure" })
		captureException("string failure")

		const [fromObject, fromString] = exporter.getFinishedSpans()
		assert.strictEqual(
			exceptionEventOf(fromObject!)?.attributes?.["exception.message"],
			"plain object failure",
		)
		assert.strictEqual(exceptionEventOf(fromString!)?.attributes?.["exception.message"], "string failure")
	})

	it("carries a custom name and caller attributes", () => {
		captureException(new Error("boom"), {
			name: "browser.uncaught_error",
			attributes: { "maple.exception.source": "window.onerror" },
		})

		const [span] = exporter.getFinishedSpans()
		assert.strictEqual(span?.name, "browser.uncaught_error")
		assert.strictEqual(span?.attributes["maple.exception.source"], "window.onerror")
	})
})

describe("setupErrorCapture", () => {
	it("captures an unhandled rejection once and stops on teardown", () => {
		const stop = setupErrorCapture()
		const reason = new Error("rejected")

		const dispatch = () =>
			window.dispatchEvent(
				Object.assign(new Event("unhandledrejection"), { reason, promise: Promise.resolve() }),
			)
		dispatch()
		// The same error object reaching a handler twice is one issue, not two.
		dispatch()
		assert.strictEqual(exporter.getFinishedSpans().length, 1)
		assert.strictEqual(exporter.getFinishedSpans()[0]?.name, "browser.unhandled_rejection")

		stop()
		exporter.reset()
		window.dispatchEvent(
			Object.assign(new Event("unhandledrejection"), {
				reason: new Error("after teardown"),
				promise: Promise.resolve(),
			}),
		)
		assert.strictEqual(exporter.getFinishedSpans().length, 0)
	})

	it("drops an opaque cross-origin script error", () => {
		const stop = setupErrorCapture()
		// No error object, no filename — "Script error." carries nothing
		// actionable and would fingerprint into one issue that buries the rest.
		window.dispatchEvent(new ErrorEvent("error", { message: "Script error.", filename: "" }))
		assert.strictEqual(exporter.getFinishedSpans().length, 0)
		stop()
	})
})
