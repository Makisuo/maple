// ---------------------------------------------------------------------------
// Buffer-backed OTLP logger (Cloudflare Workers)
//
// Pure Logger that pushes OTLP-shaped log records into a caller-owned buffer.
// Same lazy-env pattern as the tracer — URL/resource/headers resolved at flush
// time, not construction time.
// ---------------------------------------------------------------------------
import { Array as Arr, Cause, Layer, Logger, type LogLevel, References } from "effect"
import * as OtlpResource from "effect/unstable/observability/OtlpResource"

export interface LogBuffer {
	readonly loggerLayer: Layer.Layer<never>
	readonly drain: () => Array<LogRecord>
	readonly setDisabled: (value: boolean) => void
	readonly size: () => number
}

const MAX_BUFFER = 10_000

export const makeLogBuffer = (options: { readonly excludeLogSpans?: boolean } = {}): LogBuffer => {
	let buffer: Array<LogRecord> = []
	let disabled = false
	const excludeLogSpans = options.excludeLogSpans ?? false

	const logger = Logger.make<unknown, void>((logOptions) => {
		if (disabled) return
		if (buffer.length >= MAX_BUFFER) return
		buffer.push(makeLogRecord(logOptions, excludeLogSpans))
	})

	return {
		loggerLayer: Logger.layer([logger], { mergeWithExisting: true }),
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
// OTLP wire types
// ---------------------------------------------------------------------------

export interface LogRecord {
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
