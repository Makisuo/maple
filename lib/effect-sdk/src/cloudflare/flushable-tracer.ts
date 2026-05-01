// ---------------------------------------------------------------------------
// Workers-friendly OTLP tracer with explicit flush.
//
// Forked from `effect/unstable/observability/OtlpTracer` + `OtlpExporter`. Two
// differences vs. upstream:
//
//   1. No scheduled background fiber. Upstream forks an
//      `Effect.sleep + runExport` loop into the layer scope; on Cloudflare
//      Workers that's a cross-request fiber (illegal I/O) and never ticks
//      between invocations anyway.
//   2. Returns a standalone `flush` Effect the worker calls from inside
//      `ctx.waitUntil` after responding, instead of relying on the layer scope
//      finalizer (which would force per-request scope teardown).
//
// The buffer lives at module-instance scope (closed-over by `exportFn`), so
// concurrent requests in the same isolate coalesce into one POST. A 60-second
// `disabledUntil` cooldown circuit-breaker prevents thrashing a broken
// collector.
// ---------------------------------------------------------------------------
import {
	Cause,
	type Context,
	Duration,
	Effect,
	Layer,
	Number as Num,
	Option,
	Schedule,
	Tracer,
} from "effect"
import {
	Headers,
	HttpClient,
	HttpClientError,
	HttpClientRequest,
} from "effect/unstable/http"
import * as OtlpResource from "effect/unstable/observability/OtlpResource"
import type { ExtractTag } from "effect/Types"

export interface FlushableTracerOptions {
	/** Full OTLP/HTTP traces URL, e.g. `https://collector/v1/traces`. */
	readonly url: string
	readonly resource: {
		readonly serviceName: string
		readonly serviceVersion?: string | undefined
		readonly attributes?: Record<string, unknown> | undefined
	}
	readonly headers?: Headers.Input | undefined
	/** User-Agent header. Defaults to `maple-effect-sdk-cf-tracer/0.0.0`. */
	readonly userAgent?: string | undefined
}

export interface FlushableTracer {
	readonly layer: Layer.Layer<never>
	readonly flush: Effect.Effect<void, never, HttpClient.HttpClient>
}

export const makeFlushableTracer = (options: FlushableTracerOptions): FlushableTracer => {
	const otelResource = OtlpResource.make(options.resource)
	const scope: Scope = { name: options.resource.serviceName }

	const baseHeaders = Headers.fromRecordUnsafe({
		"user-agent": options.userAgent ?? "maple-effect-sdk-cf-tracer/0.0.0",
	})
	const headers = options.headers
		? Headers.merge(Headers.fromInput(options.headers), baseHeaders)
		: baseHeaders
	const request = HttpClientRequest.post(options.url, { headers })

	let buffer: Array<OtlpSpan> = []
	let disabledUntil: number | undefined = undefined

	const flush: Effect.Effect<void, never, HttpClient.HttpClient> = Effect.suspend(() => {
		if (disabledUntil !== undefined && Date.now() < disabledUntil) return Effect.void
		if (disabledUntil !== undefined) disabledUntil = undefined
		if (buffer.length === 0) return Effect.void
		const items = buffer
		buffer = []
		const body: TraceData = {
			resourceSpans: [{ resource: otelResource, scopeSpans: [{ scope, spans: items }] }],
		}
		return Effect.flatMap(HttpClient.HttpClient.asEffect(), (raw) => {
			const client = HttpClient.filterStatusOk(raw).pipe(
				HttpClient.retryTransient({ schedule: retryPolicy, times: 3 }),
			)
			return client
				.execute(HttpClientRequest.bodyJsonUnsafe(request, body))
				.pipe(Effect.asVoid, Effect.withTracerEnabled(false))
		})
	}).pipe(
		Effect.catchCause((cause) => {
			if (disabledUntil !== undefined) return Effect.void
			disabledUntil = Date.now() + 60_000
			return Effect.logDebug("flushable-tracer export failed", cause).pipe(
				Effect.annotateLogs({ package: "@maple-dev/effect-sdk", module: "FlushableTracer" }),
			)
		}),
	)

	const exportFn = (span: SpanImpl) => {
		if (!span.sampled) return
		if (disabledUntil !== undefined) return
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

	return { layer: Layer.succeed(Tracer.Tracer, tracer), flush }
}

export const noopTracer: FlushableTracer = {
	layer: Layer.empty,
	flush: Effect.void,
}

// ---------------------------------------------------------------------------
// Retry policy for 429s (copied from upstream OtlpExporter)
// ---------------------------------------------------------------------------

const retryPolicy = Schedule.forever.pipe(
	Schedule.passthrough,
	Schedule.addDelay((error: unknown) => {
		if (
			HttpClientError.isHttpClientError(error) &&
			error.reason._tag === "StatusCodeError" &&
			error.reason.response.status === 429
		) {
			const retryAfter = Option.fromUndefinedOr(error.reason.response.headers["retry-after"]).pipe(
				Option.flatMap(Num.parse),
				Option.getOrElse(() => 5),
			)
			return Effect.succeed(Duration.seconds(retryAfter))
		}
		return Effect.succeed(Duration.seconds(1))
	}),
)

// ---------------------------------------------------------------------------
// Span internals (adapted from `effect/unstable/observability/OtlpTracer`)
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
	;(self as { traceId: string }).traceId = Option.isSome(self.parent)
		? self.parent.value.traceId
		: generateId(32)
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
		parentSpanId: Option.isSome(self.parent) ? self.parent.value.spanId : undefined,
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
// OTLP wire types (subset of upstream — we only emit what we use)
// ---------------------------------------------------------------------------

interface TraceData {
	readonly resourceSpans: Array<ResourceSpan>
}
interface ResourceSpan {
	readonly resource: OtlpResource.Resource
	readonly scopeSpans: Array<ScopeSpan>
}
interface ScopeSpan {
	readonly scope: Scope
	readonly spans: Array<OtlpSpan>
}
interface Scope {
	readonly name: string
}
interface OtlpSpan {
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
