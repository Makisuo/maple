// ---------------------------------------------------------------------------
// Workers-friendly OTLP logger with explicit flush.
//
// Forked from `effect/unstable/observability/OtlpLogger` + `OtlpExporter` for
// the same reasons as the flushable tracer: no background fiber, module-scoped
// buffer for cross-request coalescing, explicit `flush` Effect for
// `ctx.waitUntil` integration.
// ---------------------------------------------------------------------------
import {
	Array as Arr,
	Cause,
	Duration,
	Effect,
	Layer,
	Logger,
	type LogLevel,
	Number as Num,
	Option,
	References,
	Schedule,
} from "effect"
import {
	Headers,
	HttpClient,
	HttpClientError,
	HttpClientRequest,
} from "effect/unstable/http"
import * as OtlpResource from "effect/unstable/observability/OtlpResource"

export interface FlushableLoggerOptions {
	/** Full OTLP/HTTP logs URL, e.g. `https://collector/v1/logs`. */
	readonly url: string
	readonly resource: {
		readonly serviceName: string
		readonly serviceVersion?: string | undefined
		readonly attributes?: Record<string, unknown> | undefined
	}
	readonly headers?: Headers.Input | undefined
	readonly userAgent?: string | undefined
	/** Skip Effect log spans in attributes. Defaults to `false`. */
	readonly excludeLogSpans?: boolean | undefined
	/** Merge with existing loggers (default `true`) instead of overwriting. */
	readonly mergeWithExisting?: boolean | undefined
}

export interface FlushableLogger {
	readonly layer: Layer.Layer<never>
	readonly flush: Effect.Effect<void, never, HttpClient.HttpClient>
}

export const makeFlushableLogger = (options: FlushableLoggerOptions): FlushableLogger => {
	const otelResource = OtlpResource.make(options.resource)
	const scope: InstrumentationScope = { name: options.resource.serviceName }

	const baseHeaders = Headers.fromRecordUnsafe({
		"user-agent": options.userAgent ?? "maple-effect-sdk-cf-logger/0.0.0",
	})
	const headers = options.headers
		? Headers.merge(Headers.fromInput(options.headers), baseHeaders)
		: baseHeaders
	const request = HttpClientRequest.post(options.url, { headers })

	let buffer: Array<LogRecord> = []
	let disabledUntil: number | undefined = undefined

	const flush: Effect.Effect<void, never, HttpClient.HttpClient> = Effect.suspend(() => {
		if (disabledUntil !== undefined && Date.now() < disabledUntil) return Effect.void
		if (disabledUntil !== undefined) disabledUntil = undefined
		if (buffer.length === 0) return Effect.void
		const items = buffer
		buffer = []
		const body: LogsData = {
			resourceLogs: [
				{ resource: otelResource, scopeLogs: [{ scope, logRecords: items }] },
			],
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
			return Effect.logDebug("flushable-logger export failed", cause).pipe(
				Effect.annotateLogs({ package: "@maple-dev/effect-sdk", module: "FlushableLogger" }),
			)
		}),
	)

	const excludeLogSpans = options.excludeLogSpans ?? false

	const logger = Logger.make<unknown, void>((logOptions) => {
		if (disabledUntil !== undefined) return
		buffer.push(makeLogRecord(logOptions, excludeLogSpans))
	})

	const layer = Logger.layer([logger], {
		mergeWithExisting: options.mergeWithExisting ?? true,
	})

	return { layer, flush }
}

export const noopLogger: FlushableLogger = {
	layer: Layer.empty,
	flush: Effect.void,
}

// ---------------------------------------------------------------------------
// Retry policy for 429s (mirrors flushable-tracer)
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
// Log record conversion (adapted from `effect/unstable/observability/OtlpLogger`)
// ---------------------------------------------------------------------------

const makeLogRecord = (
	logOptions: Logger.Options<unknown>,
	excludeLogSpans: boolean,
): LogRecord => {
	const nowMillis = logOptions.date.getTime()
	const nanosString = String(BigInt(nowMillis) * 1_000_000n)

	const attributes = OtlpResource.entriesToAttributes(
		Object.entries(logOptions.fiber.getRef(References.CurrentLogAnnotations)),
	)
	attributes.push({ key: "fiberId", value: { intValue: logOptions.fiber.id } })
	if (!excludeLogSpans) {
		for (const [label, startTime] of logOptions.fiber.getRef(References.CurrentLogSpans)) {
			attributes.push({
				key: `logSpan.${label}`,
				value: { stringValue: `${nowMillis - startTime}ms` },
			})
		}
	}
	if (logOptions.cause.reasons.length > 0) {
		attributes.push({ key: "log.error", value: { stringValue: Cause.pretty(logOptions.cause) } })
	}

	const message = Arr.ensure(logOptions.message)

	const record: LogRecord = {
		severityNumber: logLevelToSeverityNumber(logOptions.logLevel),
		severityText: logOptions.logLevel,
		timeUnixNano: nanosString,
		observedTimeUnixNano: nanosString,
		attributes,
		body: OtlpResource.unknownToAttributeValue(message.length === 1 ? message[0] : message),
		droppedAttributesCount: 0,
	}

	const currentSpan = logOptions.fiber.currentSpan
	if (currentSpan) {
		record.traceId = currentSpan.traceId
		record.spanId = currentSpan.spanId
	}

	return record
}

const logLevelToSeverityNumber = (logLevel: LogLevel.LogLevel): number => {
	switch (logLevel) {
		case "Trace":
			return 1
		case "Debug":
			return 5
		case "Info":
			return 9
		case "Warn":
			return 13
		case "Error":
			return 17
		case "Fatal":
			return 21
		default:
			return 0
	}
}

// ---------------------------------------------------------------------------
// OTLP wire types (subset — only what we emit)
// ---------------------------------------------------------------------------

interface LogsData {
	readonly resourceLogs: ReadonlyArray<ResourceLogs>
}
interface ResourceLogs {
	readonly resource: OtlpResource.Resource
	readonly scopeLogs: ReadonlyArray<ScopeLogs>
}
interface ScopeLogs {
	readonly scope: InstrumentationScope
	readonly logRecords: ReadonlyArray<LogRecord>
}
interface InstrumentationScope {
	readonly name: string
	readonly version?: string
}
interface LogRecord {
	timeUnixNano: string
	observedTimeUnixNano: string
	severityNumber?: number
	severityText?: string
	body?: OtlpResource.AnyValue
	attributes: Array<OtlpResource.KeyValue>
	droppedAttributesCount: number
	traceId?: string
	spanId?: string
}
