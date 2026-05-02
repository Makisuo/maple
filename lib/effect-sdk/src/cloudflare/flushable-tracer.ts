// ---------------------------------------------------------------------------
// Buffer-backed OTLP tracer (Cloudflare Workers)
//
// Pure Tracer that pushes OTLP-shaped spans into a caller-owned buffer. URL,
// resource, and headers are NOT baked in here — the caller (`MapleCloudflareSDK`)
// resolves them lazily from the worker `env` at first flush, so the layer
// itself can be constructed at module scope without env.
// ---------------------------------------------------------------------------
import { Cause, type Context, Layer, type Option, Tracer } from "effect"
import * as OtlpResource from "effect/unstable/observability/OtlpResource"
import type { ExtractTag } from "effect/Types"

export interface SpanBuffer {
	readonly tracerLayer: Layer.Layer<never>
	readonly drain: () => Array<OtlpSpan>
	readonly setDisabled: (value: boolean) => void
	readonly size: () => number
}

const MAX_BUFFER = 10_000

export const makeSpanBuffer = (): SpanBuffer => {
	let buffer: Array<OtlpSpan> = []
	let disabled = false

	const exportFn = (span: SpanImpl) => {
		if (disabled) return
		if (!span.sampled) return
		if (buffer.length >= MAX_BUFFER) return
		buffer.push(makeOtlpSpan(span))
	}

	const tracer = Tracer.make({
		span(spanOptions) {
			return makeSpan({
				...spanOptions,
				status: { _tag: "Started", startTime: spanOptions.startTime },
				attributes: new Map(),
				export: exportFn,
			})
		},
	})

	return {
		tracerLayer: Layer.succeed(Tracer.Tracer, tracer),
		drain: () => {
			const items = buffer
			buffer = []
			return items
		},
		setDisabled: (value) => {
			disabled = value
			if (value) buffer = []
		},
		size: () => buffer.length,
	}
}

// ---------------------------------------------------------------------------
// OTLP span construction (adapted from `effect/unstable/observability/OtlpTracer`)
// ---------------------------------------------------------------------------

const ATTR_EXCEPTION_TYPE = "exception.type"
const ATTR_EXCEPTION_MESSAGE = "exception.message"
const ATTR_EXCEPTION_STACKTRACE = "exception.stacktrace"

interface SpanImpl extends Tracer.Span {
	readonly export: (span: SpanImpl) => void
	readonly attributes: Map<string, unknown>
	readonly links: Array<Tracer.SpanLink>
	readonly events: Array<
		[name: string, startTime: bigint, attributes: Record<string, unknown> | undefined]
	>
	status: Tracer.SpanStatus
}

const SpanProto = {
	_tag: "Span" as const,
	end(this: SpanImpl, endTime: bigint, exit: import("effect/Exit").Exit<unknown, unknown>) {
		this.status = { _tag: "Ended", startTime: this.status.startTime, endTime, exit }
		this.export(this)
	},
	attribute(this: SpanImpl, key: string, value: unknown) {
		this.attributes.set(key, value)
	},
	event(this: SpanImpl, name: string, startTime: bigint, attributes?: Record<string, unknown>) {
		this.events.push([name, startTime, attributes])
	},
	addLinks(this: SpanImpl, links: ReadonlyArray<Tracer.SpanLink>) {
		this.links.push(...links)
	},
}

const makeSpan = (options: {
	readonly name: string
	readonly parent: Option.Option<Tracer.AnySpan>
	readonly annotations: Context.Context<never>
	readonly status: Tracer.SpanStatus
	readonly attributes: ReadonlyMap<string, unknown>
	readonly links: ReadonlyArray<Tracer.SpanLink>
	readonly sampled: boolean
	readonly kind: Tracer.SpanKind
	readonly export: (span: SpanImpl) => void
}): SpanImpl => {
	const self = Object.assign(Object.create(SpanProto), options) as SpanImpl
	;(self as { traceId: string }).traceId =
		self.parent._tag === "Some" ? self.parent.value.traceId : generateId(32)
	;(self as { spanId: string }).spanId = generateId(16)
	;(self as { events: unknown[] }).events = []
	return self
}

const generateId = (len: number): string => {
	const chars = "0123456789abcdef"
	let result = ""
	for (let i = 0; i < len; i++) result += chars[Math.floor(Math.random() * chars.length)]
	return result
}

const makeOtlpSpan = (self: SpanImpl): OtlpSpan => {
	const status = self.status as ExtractTag<Tracer.SpanStatus, "Ended">
	const attributes = OtlpResource.entriesToAttributes(self.attributes.entries())
	const events = self.events.map(([name, startTime, attrs]) => ({
		name,
		timeUnixNano: String(startTime),
		attributes: attrs ? OtlpResource.entriesToAttributes(Object.entries(attrs)) : [],
		droppedAttributesCount: 0,
	}))

	let otelStatus: Status
	if (status.exit._tag === "Success") {
		otelStatus = constOtelStatusSuccess
	} else if (Cause.hasInterruptsOnly(status.exit.cause)) {
		otelStatus = { code: StatusCode.Ok, message: "Interrupted" }
		attributes.push(
			{ key: "span.label", value: { stringValue: "⚠︎ Interrupted" } },
			{ key: "status.interrupted", value: { boolValue: true } },
		)
	} else {
		const errors = Cause.prettyErrors(status.exit.cause)
		otelStatus = { code: StatusCode.Error }
		const firstError = errors[0]
		if (firstError) {
			otelStatus.message = firstError.message
			for (const error of errors) {
				events.push({
					name: "exception",
					timeUnixNano: String(status.endTime),
					droppedAttributesCount: 0,
					attributes: [
						{ key: ATTR_EXCEPTION_TYPE, value: { stringValue: error.name } },
						{ key: ATTR_EXCEPTION_MESSAGE, value: { stringValue: error.message } },
						{
							key: ATTR_EXCEPTION_STACKTRACE,
							value: { stringValue: error.stack ?? "No stack trace available" },
						},
					],
				})
			}
		}
	}

	return {
		traceId: self.traceId,
		spanId: self.spanId,
		parentSpanId: self.parent._tag === "Some" ? self.parent.value.spanId : undefined,
		name: self.name,
		kind: SpanKind[self.kind],
		startTimeUnixNano: String(status.startTime),
		endTimeUnixNano: String(status.endTime),
		attributes,
		droppedAttributesCount: 0,
		events,
		droppedEventsCount: 0,
		status: otelStatus,
		links: self.links.map((link) => ({
			traceId: link.span.traceId,
			spanId: link.span.spanId,
			attributes: OtlpResource.entriesToAttributes(Object.entries(link.attributes)),
			droppedAttributesCount: 0,
		})),
		droppedLinksCount: 0,
	}
}

// ---------------------------------------------------------------------------
// OTLP wire types
// ---------------------------------------------------------------------------

export interface OtlpSpan {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string | undefined
	readonly name: string
	readonly kind: number
	readonly startTimeUnixNano: string
	readonly endTimeUnixNano: string
	readonly attributes: Array<OtlpResource.KeyValue>
	readonly droppedAttributesCount: number
	readonly events: Array<Event>
	readonly droppedEventsCount: number
	readonly status: Status
	readonly links: Array<Link>
	readonly droppedLinksCount: number
}
interface Event {
	readonly attributes: Array<OtlpResource.KeyValue>
	readonly name: string
	readonly timeUnixNano: string
	readonly droppedAttributesCount: number
}
interface Link {
	readonly attributes: Array<OtlpResource.KeyValue>
	readonly spanId: string
	readonly traceId: string
	readonly droppedAttributesCount: number
}
interface Status {
	readonly code: StatusCode
	message?: string
}

const StatusCode = {
	Unset: 0,
	Ok: 1,
	Error: 2,
} as const
type StatusCode = (typeof StatusCode)[keyof typeof StatusCode]

const SpanKind = {
	unspecified: 0,
	internal: 1,
	server: 2,
	client: 3,
	producer: 4,
	consumer: 5,
} as const

const constOtelStatusSuccess: Status = { code: StatusCode.Ok }
