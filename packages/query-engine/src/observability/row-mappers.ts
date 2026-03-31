import type { SpanResult, LogEntry, ErrorSummary } from "./types"

export const toSpanResult = (t: any): SpanResult => ({
  traceId: t.traceId,
  spanId: t.spanId ?? "",
  spanName: t.rootSpanName ?? t.spanName ?? "",
  serviceName: t.serviceName ?? (t.services as string[])?.[0] ?? "",
  durationMs: t.durationMs ?? Number(t.durationMicros) / 1000,
  statusCode: t.statusCode ?? (Number(t.hasError) ? "Error" : "Ok"),
  statusMessage: t.statusMessage ?? "",
  attributes: t.attributes ?? {},
  timestamp: t.timestamp ?? String(t.startTime ?? ""),
})

export const toLogEntry = (l: any): LogEntry => ({
  timestamp: String(l.timestamp),
  severityText: l.severityText || "INFO",
  serviceName: l.serviceName,
  body: l.body,
  traceId: l.traceId ?? "",
  spanId: l.spanId ?? "",
})

export const toErrorSummary = (e: any): ErrorSummary => ({
  errorType: e.errorType,
  count: Number(e.count),
  affectedServicesCount: Number(e.affectedServicesCount ?? 0),
  lastSeen: String(e.lastSeen),
})
