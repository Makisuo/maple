// Uncaught-error capture.
//
// Everything else this SDK exports traces something it was asked to trace: a
// fetch, a session, a custom event. An error thrown outside all of that — a
// framework render crash, a throw in an event handler, a floating rejected
// promise — had no path into Maple at all, which left the one signal a customer
// most wants from a browser SDK missing.
//
// Each error becomes a one-off span carrying an `exception` event and status
// Error. That is the shape `error_events_mv` fingerprints on, so these arrive in
// error tracking beside server-side errors rather than in a separate silo.
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { SDK_NAME, SDK_VERSION } from "./version"

export interface CaptureExceptionOptions {
	/** Span name. Default `"exception"`. */
	readonly name?: string | undefined
	/** Extra span attributes. */
	readonly attributes?: Record<string, string | number | boolean> | undefined
}

const asError = (value: unknown): Error => {
	if (value instanceof Error) return value
	if (typeof value === "string") return new Error(value)
	if (typeof value === "object" && value !== null) {
		const message = (value as { readonly message?: unknown }).message
		if (typeof message === "string") return new Error(message)
	}
	// A rejected promise can carry literally anything. `String` keeps a number or
	// a boolean legible; an unrenderable object still produces one grouped issue
	// rather than throwing inside the error handler.
	try {
		return new Error(String(value))
	} catch {
		return new Error("Unknown error")
	}
}

/**
 * Record an error that no span was watching. Safe before `init()` — without a
 * registered provider the OTel API hands back a no-op tracer and this does
 * nothing.
 */
export function captureException(error: unknown, options: CaptureExceptionOptions = {}): void {
	const normalized = asError(error)
	const span = trace.getTracer(SDK_NAME, SDK_VERSION).startSpan(options.name ?? "exception", {
		kind: SpanKind.INTERNAL,
		attributes: {
			...(typeof location !== "undefined" ? { "url.full": location.href } : undefined),
			...options.attributes,
		},
	})
	span.recordException(normalized)
	span.setStatus({ code: SpanStatusCode.ERROR, message: normalized.message })
	span.end()
}

/**
 * Register global handlers for uncaught errors and unhandled rejections.
 * Returns a teardown that removes them.
 */
export function setupErrorCapture(): () => void {
	if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
		return () => {}
	}

	// One error must not become two issues. The same throw can reach both
	// handlers (a rejected promise whose reason is later rethrown), and a host
	// app's own boundary may report it through `captureException` as well.
	const reported = new WeakSet<object>()
	const seen = (error: unknown): boolean => {
		if (typeof error !== "object" || error === null) return false
		if (reported.has(error)) return true
		reported.add(error)
		return false
	}

	const onError = (event: ErrorEvent): void => {
		// A cross-origin script surfaces as a bare "Script error." with no error
		// object and no usable frames. It fingerprints to one meaningless issue
		// that buries the real ones; the fix is `crossorigin` on the script tag,
		// not a noisier error tracker.
		const error: unknown =
			event.error ?? (event.message && event.filename ? new Error(event.message) : undefined)
		if (error === undefined || seen(error)) return
		captureException(error, {
			name: "browser.uncaught_error",
			attributes: {
				"maple.exception.source": "window.onerror",
				// `code.file.path` / `code.line.number` since semconv v1.34.0. Nothing
				// reads the names they replaced, so they are dropped rather than
				// dual-emitted — carrying both would put four near-identical rows on
				// every uncaught error in the attribute list.
				...(event.filename ? { "code.file.path": event.filename } : undefined),
				...(event.lineno ? { "code.line.number": event.lineno } : undefined),
			},
		})
	}

	const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
		if (seen(event.reason)) return
		captureException(event.reason, {
			name: "browser.unhandled_rejection",
			attributes: { "maple.exception.source": "unhandledrejection" },
		})
	}

	window.addEventListener("error", onError)
	window.addEventListener("unhandledrejection", onUnhandledRejection)
	return () => {
		window.removeEventListener("error", onError)
		window.removeEventListener("unhandledrejection", onUnhandledRejection)
	}
}
