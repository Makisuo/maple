import { type Context, context, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api"
import { CHAT_FLUE_SERVICE_NAME } from "./telemetry.ts"

/** The subset of span methods the two backends share natively. */
type RawSpan = {
	setAttribute(k: string, v: string | number | boolean): void
	setStatus?: (status: { code: SpanStatusCode; message?: string }) => void
	recordException?: Span["recordException"]
	end?: Span["end"]
}

export type SpanLike = {
	setAttribute(k: string, v: string | number | boolean): void
	/**
	 * Mark the span errored through the native OTel status API and record the
	 * exception. Maple's pipeline derives `StatusCode` from the exported status.
	 */
	setError(errorType: string, message: string): void
}

const wrap = (span: RawSpan): SpanLike => ({
	setAttribute: (k, v) => span.setAttribute(k, v),
	setError: (errorType, message) => {
		span.setAttribute("error.type", errorType)
		span.setAttribute("error.message", message)
		span.setStatus?.({ code: SpanStatusCode.ERROR, message })
		span.recordException?.({ name: errorType, message })
	},
})

export interface EnterSpanOptions {
	readonly kind?: SpanKind
	readonly parentContext?: Context
}

export async function enterSpan<T>(
	name: string,
	fn: (span: SpanLike) => Promise<T>,
	options: EnterSpanOptions = {},
): Promise<T> {
	const tracer = trace.getTracer(CHAT_FLUE_SERVICE_NAME)
	return tracer.startActiveSpan(
		name,
		{ kind: options.kind ?? SpanKind.INTERNAL },
		options.parentContext ?? context.active(),
		async (span) => {
			const wrapped = wrap(span)
			try {
				return await fn(wrapped)
			} catch (error) {
				wrapped.setError(
					error instanceof Error ? error.name : "UnknownError",
					error instanceof Error ? error.message : String(error),
				)
				throw error
			} finally {
				span.end()
			}
		},
	)
}
