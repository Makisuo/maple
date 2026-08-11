import { describe, expect, it } from "vitest"
import { SpanId } from "@maple/domain"
import type { SpanNode } from "@maple/query-engine/observability"
import { Schema } from "effect"
import { renderTraceOverview, type TraceOverviewLog } from "./render-trace"

const decodeSpanId = Schema.decodeSync(SpanId)

function span(
	id: string,
	opts: Partial<Omit<SpanNode, "spanId" | "children">> & { children?: SpanNode[] } = {},
): SpanNode {
	return {
		spanId: decodeSpanId(id),
		parentSpanId: opts.parentSpanId ?? "",
		spanName: opts.spanName ?? id,
		serviceName: opts.serviceName ?? "svc",
		spanKind: opts.spanKind ?? "Internal",
		durationMs: opts.durationMs ?? 1,
		statusCode: opts.statusCode ?? "Unset",
		statusMessage: opts.statusMessage ?? "",
		attributes: opts.attributes ?? {},
		resourceAttributes: opts.resourceAttributes ?? {},
		children: opts.children ?? [],
	}
}

const base = {
	traceId: "trace-abc",
	serviceCount: 1,
	rootDurationMs: 100,
	logs: [] as TraceOverviewLog[],
}

describe("renderTraceOverview", () => {
	it("renders every span with a copyable span id and no truncation note for small traces", () => {
		const spans = [span("root", { children: [span("child-1"), span("child-2")] })]
		const { lines, overview } = renderTraceOverview({ ...base, spanCount: 3, spans, budget: 100 })
		const text = lines.join("\n")

		expect(overview.truncated).toBe(false)
		expect(text).not.toContain("Showing")
		expect(text).toContain("span=root")
		expect(text).toContain("span=child-1")
		expect(text).toContain("span=child-2")
	})

	it("bounds a large trace and emits a Showing N of M note + collapse markers", () => {
		const children = Array.from({ length: 20 }, (_, i) => span(`b${i}`, { durationMs: 1 }))
		const spans = [
			span("root", {
				durationMs: 100,
				spanKind: "Server",
				children: [span("hot", { durationMs: 90, children }), span("err", { statusCode: "Error" })],
			}),
		]
		const totalSpanCount = 1 + 1 + 20 + 1
		const { lines, overview } = renderTraceOverview({
			...base,
			spanCount: totalSpanCount,
			spans,
			budget: 5,
		})
		const text = lines.join("\n")

		expect(overview.truncated).toBe(true)
		expect(text).toContain(`Showing ${overview.renderedCount} of ${totalSpanCount} spans`)
		// The error span is always kept and labelled.
		expect(text).toContain("span=err")
		expect(text).toContain("[Error]")
		// Dropped children are summarised, not dumped.
		expect(text).toMatch(/… \+\d+ more spans/)
	})

	it("renders related logs with a severity marker and span ref", () => {
		const spans = [span("root")]
		const logs: TraceOverviewLog[] = [
			{
				timestamp: "2026-06-02 10:00:00",
				severityText: "ERROR",
				serviceName: "api",
				body: "boom",
				spanId: "deadbeefcafef00d",
			},
			{
				timestamp: "2026-06-02 10:00:01",
				severityText: "info",
				serviceName: "api",
				body: "ok",
				spanId: "",
			},
		]
		const { lines } = renderTraceOverview({ ...base, spanCount: 1, spans, logs, budget: 100 })
		const text = lines.join("\n")

		expect(text).toContain("Related Logs (2):")
		expect(text).toContain("● ") // ERROR marker
		expect(text).toContain("span:deadbeef") // short span ref for the error log
	})
})
