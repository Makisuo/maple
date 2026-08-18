import { Layer, type Exit, Tracer } from "effect"

export interface EndedSpan {
	readonly name: string
	readonly attributes: ReadonlyMap<string, unknown>
	/** The exit the span closed with — `Failure` is what becomes OTLP `Error`. */
	readonly exit: Exit.Exit<unknown, unknown>
}

/**
 * A tracer that records every span's END, including the exit it closed with.
 * `Tracer.NativeSpan` doesn't expose the exit status, and the exit is exactly
 * what decides whether a span is reported as `Error` — which is the contract
 * these tests pin (an expected 402 must not close a span as an error).
 */
export const makeCapturingTracer = () => {
	const ended: Array<EndedSpan> = []
	let spanCounter = 0
	const tracer = Tracer.make({
		span(options) {
			const attributes = new Map<string, unknown>()
			const span: Tracer.Span = {
				_tag: "Span",
				name: options.name,
				traceId: `test-trace-${spanCounter}`,
				spanId: `test-span-${spanCounter++}`,
				parent: options.parent,
				annotations: options.annotations,
				links: options.links,
				sampled: options.sampled,
				kind: options.kind,
				status: { _tag: "Started", startTime: options.startTime },
				attributes,
				end(_endTime, exit) {
					ended.push({ name: span.name, attributes, exit })
				},
				attribute(key, value) {
					attributes.set(key, value)
				},
				event() {},
				addLinks() {},
			}
			return span
		},
	})
	return { ended, layer: Layer.succeed(Tracer.Tracer, tracer) }
}

/** All recorded spans with the given name, in end order. */
export const endedSpansNamed = (ended: ReadonlyArray<EndedSpan>, name: string) =>
	ended.filter((span) => span.name === name)
