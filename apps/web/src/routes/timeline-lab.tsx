import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"

import { TraceViewTabs } from "@maple/ui/components/traces/trace-view-tabs"
import { buildTraceDetail, type SpanHierarchyRow } from "@maple/ui/lib/span-tree"
import type { SpanNode } from "@maple/ui/lib/types"
import { formatWarehouseDateTimeMs } from "@maple/query-engine"

export const Route = createFileRoute("/timeline-lab")({ component: TimelineLab })

const T0_MS = new Date("2026-07-21T10:00:00.000Z").getTime()

function at(offsetMs: number): string {
	return formatWarehouseDateTimeMs(T0_MS + offsetMs)
}

function row(overrides: Partial<SpanHierarchyRow> & { spanId: string; spanName: string }): SpanHierarchyRow {
	return {
		traceId: "timeline-lab-trace",
		parentSpanId: "",
		serviceName: "checkout-api",
		spanKind: "SPAN_KIND_INTERNAL",
		durationMs: 20,
		startTime: at(0),
		statusCode: "Ok",
		statusMessage: "",
		spanAttributes: "{}",
		resourceAttributes: "{}",
		...overrides,
	}
}

// A wide dynamic range on purpose: a 2s root, mid-size children, and a fan of
// sub-millisecond spans that only become legible at deep zoom.
const ROWS: SpanHierarchyRow[] = [
	row({ spanId: "root", spanName: "POST /api/checkout", spanKind: "SPAN_KIND_SERVER", durationMs: 2000 }),
	...Array.from({ length: 6 }, (_, i) =>
		row({
			spanId: `svc${i}`,
			parentSpanId: "root",
			spanName: `stage-${i} handler`,
			serviceName: ["checkout-api", "payments", "inventory", "search", "mailer", "edge"][i],
			spanKind: "SPAN_KIND_INTERNAL",
			startTime: at(20 + i * 300),
			durationMs: 260,
			statusCode: i === 3 ? "Error" : "Ok",
		}),
	),
	...Array.from({ length: 40 }, (_, i) =>
		row({
			spanId: `q${i}`,
			parentSpanId: `svc${i % 6}`,
			spanName: `SELECT shard_${i}`,
			serviceName: "postgres",
			spanKind: "SPAN_KIND_CLIENT",
			startTime: at(25 + (i % 6) * 300 + (i % 7) * 30),
			// Sub-ms spans: invisible zoomed out, the reason zoom has to work.
			durationMs: 0.08 + (i % 5) * 0.4,
		}),
	),
	...Array.from({ length: 12 }, (_, i) =>
		row({
			spanId: `deep${i}`,
			parentSpanId: i === 0 ? "svc1" : `deep${i - 1}`,
			spanName: `nested level ${i}`,
			serviceName: "payments",
			startTime: at(330 + i * 3),
			durationMs: 200 - i * 12,
		}),
	),
]

const DETAIL = buildTraceDetail(ROWS)

function TimelineLab() {
	const [selected, setSelected] = useState<SpanNode | undefined>(undefined)
	return (
		<div className="h-screen p-4">
			<TraceViewTabs
				rootSpans={DETAIL.rootSpans}
				spans={DETAIL.spans}
				totalDurationMs={DETAIL.totalDurationMs}
				traceStartTime={DETAIL.traceStartTime}
				services={DETAIL.services}
				selectedSpanId={selected?.spanId}
				onSelectSpan={setSelected}
			/>
		</div>
	)
}
