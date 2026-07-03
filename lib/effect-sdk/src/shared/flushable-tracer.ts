// ---------------------------------------------------------------------------
// Buffer-backed OTLP tracer (platform-agnostic)
//
// Pure Tracer that pushes OTLP-shaped spans into a caller-owned buffer. URL,
// resource, and headers are NOT baked in here — the caller (the Cloudflare,
// server, or client flushable preset) resolves them and POSTs the drained
// buffer on `flush`, so the layer itself can be constructed without I/O.
// ---------------------------------------------------------------------------
import { Cause, type Context, Layer, type Option, Predicate, Tracer } from "effect"
import * as ErrorReporter from "effect/ErrorReporter"
import * as OtlpResource from "effect/unstable/observability/OtlpResource"
import type { ExtractTag } from "effect/Types"

export interface SpanBuffer {
	readonly tracerLayer: Layer.Layer<never>
	readonly drain: () => Array<OtlpSpan>
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
	 * `_tag`s of failures that represent *anticipated* outcomes (expected 4xx
	 * business errors: validation, not-found, unauthorized, …). When a span's
	 * failure is caused *entirely* by errors with one of these tags, the span is
	 * still exported (so latency / `http.response.status_code` stay visible) but
	 * with OTLP status `Ok` and **no** `exception` event — so it never lands in
	 * error tracking (`error_events_mv` keys off `StatusCode='Error'`). Mirrors
	 * the ingest gateway's `otel_status_for_rejection` (4xx → Ok) rule.
	 *
	 * Distinct from Effect's `ErrorReporter.ignore` flag, which *drops* the span
	 * entirely (used for benign routing 404s).
	 */
	readonly anticipatedErrorTags?: ReadonlySet<string> | undefined
}

// Errors carrying Effect's `[ErrorReporter.ignore]` flag are benign by design —
// Effect's own "don't report this failure" signal. The canonical case is
// `HttpServerError { reason: RouteNotFound }` (unmatched routes → 404), which
// would otherwise surface as an Error-status span. We key off the annotation
// rather than concrete error tags so the check stays robust and HTTP-agnostic;
// genuine failures (400 parse errors, 500s) keep `ignore = false` and trace.
const isIgnoredFailure = (error: unknown): boolean =>
	Predicate.hasProperty(error, ErrorReporter.ignore) && error[ErrorReporter.ignore] === true

const isIgnoredSpan = (span: SpanImpl): boolean => {
	const status = span.status
	if (status._tag !== "Ended") return false
	const exit = status.exit
	if (exit._tag !== "Failure") return false
	// Cause is flat in effect v4: walk `reasons`, pick Fail reasons, inspect their error.
	return exit.cause.reasons.some((reason) => Cause.isFailReason(reason) && isIgnoredFailure(reason.error))
}

export const makeSpanBuffer = (options: SpanBufferOptions = {}): SpanBuffer => {
	let buffer: Array<OtlpSpan> = []
	let disabled = false
	const dropSpan = options.dropSpan
	const anticipatedErrorTags = options.anticipatedErrorTags

	const exportFn = (span: SpanImpl) => {
		if (disabled) return
		if (!span.sampled) return
		if (dropSpan !== undefined && dropSpan(span.name)) return
		if (isIgnoredSpan(span)) return
		if (buffer.length >= MAX_BUFFER) return
		buffer.push(makeOtlpSpan(span, anticipatedErrorTags))
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

// A failure is "anticipated" when its `_tag` is in the configured set. A span
// whose failure is caused *entirely* by anticipated errors (no defects/Die)
// records OTLP status `Ok` and emits no `exception` event.
const isAnticipatedFailure = (error: unknown, tags: ReadonlySet<string>): boolean =>
	Predicate.hasProperty(error, "_tag") && typeof error._tag === "string" && tags.has(error._tag)

const isFullyAnticipated = (
	cause: Cause.Cause<unknown>,
	tags: ReadonlySet<string> | undefined,
): boolean => {
	if (tags === undefined || tags.size === 0) return false
	if (cause.reasons.some(Cause.isDieReason)) return false
	const failErrors = cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
	return failErrors.length > 0 && failErrors.every((error) => isAnticipatedFailure(error, tags))
}

const makeOtlpSpan = (self: SpanImpl, anticipatedErrorTags?: ReadonlySet<string>): OtlpSpan => {
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
	} else if (isFullyAnticipated(status.exit.cause, anticipatedErrorTags)) {
		// Expected business outcome (4xx). Keep the span (latency / status code
		// stay visible) but don't flag it as an error or fingerprint it.
		otelStatus = constOtelStatusSuccess
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
