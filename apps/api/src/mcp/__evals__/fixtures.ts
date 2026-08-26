import type { SpanHierarchyOutput, ListLogsOutput } from "@maple/domain/tinybird"
import { FIXTURES } from "./utils"

const hex = (n: number): string => n.toString(16).padStart(16, "0")

/** Total spans in the synthetic large trace (> MAX_OVERVIEW_SPANS=100 to force the cap). */
export const LARGE_TRACE_SPAN_COUNT = 150

/**
 * A synthetic large trace: one root server span with many short children and a
 * single error span. Exceeding the 100-span overview budget makes `inspect_trace`
 * render the "Showing N of M spans" note — the Part-1 behavior under test.
 */
export const makeLargeTraceSpans = (count = LARGE_TRACE_SPAN_COUNT): SpanHierarchyOutput[] => {
	const traceId = FIXTURES.traceId
	const rootId = FIXTURES.spanId
	const rows: SpanHierarchyOutput[] = [
		{
			traceId,
			spanId: rootId,
			parentSpanId: "",
			spanName: "GET /api/checkout",
			serviceName: FIXTURES.service,
			spanKind: "Server",
			durationMs: 850,
			startTime: "2026-06-02 10:00:00",
			statusCode: "Ok",
			statusMessage: "",
			spanAttributes: "{}",
			resourceAttributes: "{}",
			relationship: "related",
		},
	]
	for (let i = 0; i < count - 1; i++) {
		const isError = i === 7
		rows.push({
			traceId,
			spanId: hex(0x1000 + i),
			parentSpanId: rootId,
			spanName: isError ? "db.query users" : `op-${i}`,
			serviceName: i % 3 === 0 ? "db" : FIXTURES.service,
			spanKind: "Internal",
			durationMs: isError ? 120 : (i % 10) + 1,
			startTime: "2026-06-02 10:00:00",
			statusCode: isError ? "Error" : "Ok",
			statusMessage: isError ? "connection reset by peer" : "",
			spanAttributes: "{}",
			resourceAttributes: "{}",
			relationship: "related",
		})
	}
	return rows
}

/** A distinct trace id for the "small trace renders in full" regression guard. */
export const SMALL_TRACE_ID = "5b8aa5a2d2c872e8321cf37308d69df2"

/**
 * A small trace (1 root + 4 children, all Ok) — well under MAX_OVERVIEW_SPANS,
 * so `inspect_trace` must render the full tree with NO "Showing N of M" note.
 */
export const makeSmallTraceSpans = (): SpanHierarchyOutput[] => {
	const rootId = "aaaa000000000001"
	const root: SpanHierarchyOutput = {
		traceId: SMALL_TRACE_ID,
		spanId: rootId,
		parentSpanId: "",
		spanName: "GET /api/orders",
		serviceName: FIXTURES.service,
		spanKind: "Server",
		durationMs: 42,
		startTime: "2026-06-02 10:00:00",
		statusCode: "Ok",
		statusMessage: "",
		spanAttributes: "{}",
		resourceAttributes: "{}",
		relationship: "related",
	}
	const children = Array.from(
		{ length: 4 },
		(_, i): SpanHierarchyOutput => ({
			traceId: SMALL_TRACE_ID,
			spanId: `aaaa00000000001${i}`,
			parentSpanId: rootId,
			spanName: `step-${i}`,
			serviceName: FIXTURES.service,
			spanKind: "Internal",
			durationMs: i + 1,
			startTime: "2026-06-02 10:00:00",
			statusCode: "Ok",
			statusMessage: "",
			spanAttributes: "{}",
			resourceAttributes: "{}",
			relationship: "related",
		}),
	)
	return [root, ...children]
}

/** Trace + span ids for the `inspect_span` drill-down regression guards. */
export const SPAN_DETAIL_TRACE_ID = "9c2f1e7a4b6d83f05e1a2c3d4e5f6071"
export const SPAN_DETAIL_SPAN_ID = "c1c1c1c1c1c1c1c1"
export const MISSING_SPAN_ID = "deadbeefdeadbeef"

/** One full-attribute row for `inspect_span` (shape: spanDetailQuery output). */
export const makeSpanDetailRows = (): ReadonlyArray<Record<string, unknown>> => [
	{
		traceId: SPAN_DETAIL_TRACE_ID,
		spanId: SPAN_DETAIL_SPAN_ID,
		// Every column `spanDetailQuery` selects — the row is validated against
		// the compiled query's schema now, so a partial one is a decode failure.
		parentSpanId: "",
		spanName: "POST /api/checkout",
		serviceName: FIXTURES.service,
		spanKind: "Server",
		durationMs: 120,
		startTime: "2026-06-02 10:00:00",
		statusCode: "Ok",
		statusMessage: "",
		spanAttributes: JSON.stringify({ "http.method": "POST", "http.route": "/api/checkout" }),
		resourceAttributes: JSON.stringify({ "service.name": FIXTURES.service }),
	},
]

export const makeTraceLogs = (): ListLogsOutput[] => [
	{
		timestamp: "2026-06-02 10:00:00",
		severityText: "ERROR",
		severityNumber: 17,
		serviceName: FIXTURES.service,
		body: "checkout failed: downstream db error",
		traceId: FIXTURES.traceId,
		spanId: FIXTURES.spanId,
		// The list-logs cursor identity — a real selected column, so a row without
		// it no longer decodes.
		recordIdentity: "0123456789ABCDEF0123456789ABCDEF",
		logAttributes: "{}",
		resourceAttributes: "{}",
	},
]
