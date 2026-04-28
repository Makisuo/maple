import { Schema } from "effect"
import { TraceId } from "@maple/domain"
import type { ListTracesOutput, ListLogsOutput, ErrorsByTypeOutput } from "@maple/domain/tinybird"
import type { SpanResult, LogEntry, ErrorSummary } from "./types"

export const toSpanResult = (t: ListTracesOutput): SpanResult => ({
	traceId: Schema.decodeSync(TraceId)(t.traceId),
	spanId: null,
	spanName: t.rootSpanName,
	serviceName: t.services[0] ?? "",
	durationMs: Number(t.durationMicros) / 1000,
	statusCode: Number(t.hasError) ? "Error" : "Ok",
	statusMessage: "",
	attributes: {},
	resourceAttributes: {},
	timestamp: String(t.startTime ?? ""),
})

export const toLogEntry = (l: ListLogsOutput): LogEntry => ({
	timestamp: String(l.timestamp),
	severityText: l.severityText || "INFO",
	serviceName: l.serviceName,
	body: l.body,
	traceId: l.traceId ?? "",
	spanId: l.spanId ?? "",
})

export const toErrorSummary = (e: ErrorsByTypeOutput): ErrorSummary => ({
	errorType: e.errorType,
	count: Number(e.count),
	affectedServicesCount: Number(e.affectedServicesCount),
	lastSeen: String(e.lastSeen),
})
