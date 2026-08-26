// Warehouse rows -> the observability view models.
//
// The `Number(...)` / `String(...)` wrappers that used to be on every field
// here were a second, untyped parse layer: rows now decode through the compiled
// query's row schema, which is where a quoted `UInt64` becomes a number and a
// missing column becomes an error. Coercing again downstream only hid which
// layer was responsible.

import { Schema } from "effect"
import { TraceId } from "@maple/domain"
import type { ListTracesOutput, ListLogsOutput, ErrorsByTypeOutput } from "@maple/domain/tinybird"
import type { SpanResult, LogEntry, ErrorSummary } from "./types"

export const toSpanResult = (t: ListTracesOutput): SpanResult => ({
	traceId: Schema.decodeSync(TraceId)(t.traceId),
	spanId: null,
	spanName: t.rootSpanName,
	serviceName: t.services[0] ?? "",
	durationMs: t.durationMicros / 1000,
	statusCode: t.hasError ? "Error" : "Ok",
	statusMessage: "",
	attributes: {},
	resourceAttributes: {},
	timestamp: t.startTime,
})

export const toLogEntry = (l: ListLogsOutput): LogEntry => ({
	timestamp: l.timestamp,
	severityText: l.severityText || "INFO",
	serviceName: l.serviceName,
	body: l.body,
	traceId: l.traceId,
	spanId: l.spanId,
})

export const toErrorSummary = (e: ErrorsByTypeOutput): ErrorSummary => ({
	fingerprintHash: e.fingerprintHash,
	label: e.errorLabel,
	count: e.count,
	affectedServicesCount: e.affectedServicesCount,
	lastSeen: e.lastSeen,
})
