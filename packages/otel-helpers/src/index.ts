import {
	type Attributes,
	type Context,
	type Link,
	type Span,
	type SpanKind,
	SpanStatusCode,
	type Tracer,
} from "@opentelemetry/api"

export interface WithSpanOptions {
	tracer: Tracer
	attributes?: Attributes
	kind?: SpanKind
	links?: Link[]
	startTime?: number
	root?: boolean
	parent?: Context
}

export function withSpan<T>(
	name: string,
	fn: (span: Span) => Promise<T> | T,
	options: WithSpanOptions,
): Promise<T> {
	const { tracer, parent, ...spanOptions } = options
	const run = (span: Span): Promise<T> =>
		Promise.resolve()
			.then(() => fn(span))
			.then(
				(value) => {
					span.end()
					return value
				},
				(err: unknown) => {
					recordError(span, err)
					span.end()
					throw err
				},
			)

	if (parent) {
		return tracer.startActiveSpan(name, spanOptions, parent, run)
	}
	return tracer.startActiveSpan(name, spanOptions, run)
}

function recordError(span: Span, err: unknown): void {
	if (err instanceof Error) {
		span.recordException(err)
		span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
		return
	}
	const message = typeof err === "string" ? err : String(err)
	span.recordException({ name: "NonErrorThrown", message })
	span.setStatus({ code: SpanStatusCode.ERROR, message })
}
