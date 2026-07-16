import { SpanStatusCode, trace } from "@opentelemetry/api"
import { CHAT_FLUE_SERVICE_NAME } from "./telemetry.ts"

/** The subset of span methods the two backends share natively. */
type RawSpan = {
	setAttribute(k: string, v: string | number | boolean): void
	recordException?: (error: Error) => void
	setStatus?: (status: { code: SpanStatusCode; message?: string }) => void
	end?: () => void
}

export type SpanLike = {
	setAttribute(k: string, v: string | number | boolean): void
	/**
	 * Mark the span errored following OTEL semconv: sets the native span status
	 * (OTel fallback tracer) plus the `otel.status_code` attribute Maple's
	 * pipeline reads to drive the `StatusCode='Error'` dashboards, and the
	 * semconv `error.type`. Title-Case status per the repo convention.
	 */
	setError(errorType: string, message: string): void
}

const wrap = (span: RawSpan): SpanLike => ({
	setAttribute: (k, v) => span.setAttribute(k, v),
	setError: (errorType, message) => {
		span.setAttribute("otel.status_code", "Error")
		span.setAttribute("error.type", errorType)
		span.setAttribute("error.message", message)
		span.setStatus?.({ code: SpanStatusCode.ERROR, message })
	},
})

export async function enterSpan<T>(name: string, fn: (span: SpanLike) => Promise<T>): Promise<T> {
	let cloudflareTracing: (typeof import("cloudflare:workers"))["tracing"] | undefined
	try {
		cloudflareTracing = (await import("cloudflare:workers")).tracing
	} catch {
		// The workerd-only module is unavailable in local Node runtimes.
	}

	if (cloudflareTracing) {
		return cloudflareTracing.enterSpan(name, (span) => fn(wrap(span)))
	}

	return trace.getTracer(CHAT_FLUE_SERVICE_NAME).startActiveSpan(name, async (span) => {
		try {
			return await fn(wrap(span))
		} catch (error) {
			const exception = error instanceof Error ? error : new Error(String(error))
			wrap(span).setError(exception.name, exception.message)
			span.recordException(exception)
			throw error
		} finally {
			span.end()
		}
	})
}
