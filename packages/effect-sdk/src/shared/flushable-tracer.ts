// Buffer-backed OTLP tracer (platform-agnostic)
//
// Pure Tracer that pushes OTLP-shaped spans into a caller-owned buffer. URL,
// resource, and headers are NOT baked in here — the caller (the Cloudflare,
// server, or client flushable preset) resolves them and POSTs the drained
// buffer on `flush`, so the layer itself can be constructed without I/O.
import { Cause, Context, Exit, Layer, Option, Tracer } from "effect"
import * as OtlpResource from "effect/unstable/observability/OtlpResource"
import type { ExtractTag } from "effect/Types"
import { classifySpanExit, HTTP_SERVER_ERROR_RESPONSE, type SpanOutcome } from "./span-exit.js"

export interface CaptureExceptionOptions {
	/** Span name. Default `"exception"`. */
	readonly name?: string | undefined
	/** Extra span attributes (e.g. the URL the error happened on). */
	readonly attributes?: Record<string, unknown> | undefined
}

export interface SpanBuffer {
	readonly tracerLayer: Layer.Layer<never>
	/**
	 * Record a thrown value that never passed through an Effect span.
	 *
	 * Everything else in this buffer arrives because an Effect *span* failed —
	 * which means an error thrown outside Effect had no path here at all. In a
	 * browser that is most of them: a React render crash caught by an error
	 * boundary, a throw in an event handler, a rejected promise nobody awaited.
	 *
	 * The error is recorded as a one-off span carrying a `Die` cause, so it takes
	 * the same road as every other failure: `makeOtlpSpan` gives it status
	 * `Error` and an `exception` event with type/message/stacktrace, which is
	 * exactly the shape `error_events_mv` fingerprints on. A `Die` (not a `Fail`)
	 * because an uncaught throw is by definition not an anticipated failure —
	 * that also keeps it clear of the `anticipatedErrorIdentifiers` filter, which
	 * would otherwise let a caller silence real crashes by tag.
	 *
	 * BOUNDARY: a thrown value is unparsed by definition — JavaScript can throw
	 * anything. `Cause.prettyErrors` narrows it on the way into the event.
	 */
	readonly captureException: (error: unknown, options?: CaptureExceptionOptions) => void
	readonly drain: () => Array<OtlpSpan>
	readonly restore: (items: ReadonlyArray<OtlpSpan>) => void
	readonly setDisabled: (value: boolean) => void
	readonly size: () => number
}

const MAX_BUFFER = 10_000

export interface SpanBufferOptions {
	/**
	 * Predicate run on each finished span before it's added to the buffer.
	 * Returning `true` drops the span — it never reaches the OTLP exporter.
	 * Use to suppress known-noisy span names (e.g. MCP protocol notifications).
	 */
	readonly dropSpan?: ((name: string) => boolean) | undefined
	/**
	 * Stable `_tag` or `Error.name` identifiers for failures that represent
	 * anticipated outcomes (expected 4xx business errors: validation, not-found,
	 * unauthorized, …). When a span's failure is caused *entirely* by errors with
	 * one of these identifiers, the span is
	 * still exported (so latency / `http.response.status_code` stay visible) but
	 * with OTLP status `Ok` and **no** `exception` event — so it never lands in
	 * error tracking (`error_events_mv` keys off `StatusCode='Error'`). Mirrors
	 * the ingest gateway's `otel_status_for_rejection` (4xx → Ok) rule.
	 *
	 * Distinct from Effect's `ErrorReporter.ignore` flag, which *drops* the span
	 * entirely (used for benign routing 404s).
	 */
	readonly anticipatedErrorIdentifiers?: ReadonlySet<string> | undefined
	/** @deprecated Use `anticipatedErrorIdentifiers`. */
	readonly anticipatedErrorTags?: ReadonlySet<string> | undefined
}

export const makeSpanBuffer = (options: SpanBufferOptions = {}): SpanBuffer => {
	let buffer: Array<OtlpSpan> = []
	let disabled = false
	const dropSpan = options.dropSpan
	const anticipatedErrorIdentifiers = options.anticipatedErrorIdentifiers ?? options.anticipatedErrorTags

	const exportFn = (span: SpanImpl) => {
		if (disabled) return
		if (!span.sampled) return
		if (dropSpan !== undefined && dropSpan(span.name)) return
		if (span.status._tag !== "Ended") return
		const outcome = classifySpanExit(
			{ exit: span.status.exit, kind: span.kind, attributes: span.attributes },
			anticipatedErrorIdentifiers,
		)
		// Benign by Effect's own reckoning (`[ErrorReporter.ignore]`, e.g. a
		// RouteNotFound 404): never exported, unlike the `Anticipated` case below.
		if (outcome._tag === "Ignored") return
		if (buffer.length >= MAX_BUFFER) return
		buffer.push(makeOtlpSpan(span, outcome))
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

	const captureException = (error: unknown, captureOptions: CaptureExceptionOptions = {}): void => {
		if (disabled) return
		const now = BigInt(Date.now()) * 1_000_000n
		const span = makeSpan({
			name: captureOptions.name ?? "exception",
			parent: Option.none(),
			annotations: Context.empty(),
			status: { _tag: "Started", startTime: now },
			attributes: new Map(Object.entries(captureOptions.attributes ?? {})),
			links: [],
			sampled: true,
			kind: "internal",
			export: exportFn,
		})
		span.end(now, Exit.failCause(Cause.die(error)))
	}

	return {
		tracerLayer: Layer.succeed(Tracer.Tracer, tracer),
		captureException,
		drain: () => {
			const items = buffer
			buffer = []
			return items
		},
		restore: (items) => {
			if (disabled || items.length === 0) return
			buffer = [...items, ...buffer].slice(0, MAX_BUFFER)
		},
		setDisabled: (value) => {
			disabled = value
			if (value) buffer = []
		},
		size: () => buffer.length,
	}
}

// OTLP span construction (adapted from `effect/unstable/observability/OtlpTracer`)

const ATTR_EXCEPTION_TYPE = "exception.type"
const ATTR_EXCEPTION_MESSAGE = "exception.message"
const ATTR_EXCEPTION_STACKTRACE = "exception.stacktrace"

interface SpanImpl extends Tracer.Span {
	readonly export: (span: SpanImpl) => void
	readonly attributes: Map<string, unknown>
	readonly links: Array<Tracer.SpanLink>
	readonly events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown> | undefined]>
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

const makeOtlpSpan = (self: SpanImpl, outcome: SpanOutcome): OtlpSpan => {
	const status = self.status as ExtractTag<Tracer.SpanStatus, "Ended">
	const attributes = OtlpResource.entriesToAttributes(self.attributes.entries())
	const events = self.events.map(([name, startTime, attrs]) => ({
		name,
		timeUnixNano: String(startTime),
		attributes: attrs ? OtlpResource.entriesToAttributes(Object.entries(attrs)) : [],
		droppedAttributesCount: 0,
	}))

	let otelStatus: Status
	if (outcome._tag === "ServerError") {
		otelStatus = { code: StatusCode.Error, message: outcome.message }
		events.push({
			name: "exception",
			timeUnixNano: String(status.endTime),
			droppedAttributesCount: 0,
			attributes: [
				{ key: ATTR_EXCEPTION_TYPE, value: { stringValue: HTTP_SERVER_ERROR_RESPONSE } },
				{ key: ATTR_EXCEPTION_MESSAGE, value: { stringValue: outcome.message } },
			],
		})
	} else if (outcome._tag === "Interrupted") {
		otelStatus = { code: StatusCode.Ok, message: "Interrupted" }
		attributes.push(
			{ key: "span.label", value: { stringValue: "⚠︎ Interrupted" } },
			{ key: "status.interrupted", value: { boolValue: true } },
		)
	} else if (outcome._tag !== "Failed") {
		// Success, or an expected business outcome (4xx): keep the span (latency /
		// status code stay visible) but don't flag it as an error or fingerprint it.
		otelStatus = constOtelStatusSuccess
	} else {
		const errors = outcome.errors
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

// OTLP wire types

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
