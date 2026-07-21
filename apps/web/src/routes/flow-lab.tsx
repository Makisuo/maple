import { useState } from "react"
import { createFileRoute } from "@tanstack/react-router"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TraceFlowView } from "@maple/ui/components/traces/flow-view"
import { buildTraceDetail, type SpanHierarchyRow } from "@maple/ui/lib/span-tree"
import type { SpanNode } from "@maple/ui/lib/types"

export const Route = createFileRoute("/flow-lab")({
	component: FlowLab,
})

const T0_MS = new Date("2026-07-21T10:00:00.000Z").getTime()

/** Trace-relative start time so edges get realistic "+Nms" start offsets. */
function at(offsetMs: number): string {
	return new Date(T0_MS + offsetMs).toISOString().replace("T", " ").replace("Z", "")
}

function row(overrides: Partial<SpanHierarchyRow> & { spanId: string; spanName: string }): SpanHierarchyRow {
	return {
		traceId: "flow-lab-trace",
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

// One synthetic trace exercising every card variant: server root, Cloudflare
// platform span, HTTP client (ok + erroring), Postgres + combined ClickHouse
// db spans, Redis cache hit/miss, producer/consumer messaging, Class.method
// function spans, a bare internal span, and an orphan child that renders the
// missing-span placeholder.
const ROWS: SpanHierarchyRow[] = [
	row({
		spanId: "root",
		spanName: "POST /api/checkout",
		spanKind: "SPAN_KIND_SERVER",
		durationMs: 480,
		spanAttributes: JSON.stringify({
			"http.request.method": "POST",
			"http.route": "/api/checkout",
			"http.response.status_code": "200",
		}),
	}),
	row({
		spanId: "edge",
		startTime: at(2),
		parentSpanId: "root",
		spanName: "checkout-edge fetch",
		serviceName: "edge-router",
		spanKind: "SPAN_KIND_SERVER",
		durationMs: 34,
		spanAttributes: JSON.stringify({
			"cloud.platform": "cloudflare.workers",
			"cloudflare.script_name": "checkout-edge",
			"cloudflare.colo": "ORD",
			"cloudflare.outcome": "ok",
		}),
	}),
	row({
		spanId: "auth",
		startTime: at(6),
		parentSpanId: "root",
		spanName: "SessionAuthn.verify",
		serviceName: "identity",
		durationMs: 8,
	}),
	row({
		spanId: "pricing",
		startTime: at(16),
		parentSpanId: "root",
		spanName: "PricingEngine.calculateTotals",
		durationMs: 96,
	}),
	row({
		spanId: "cache-hit",
		startTime: at(18),
		parentSpanId: "pricing",
		spanName: "cache.get price-book",
		durationMs: 2,
		spanAttributes: JSON.stringify({
			"cache.system": "redis",
			"cache.name": "price-book:v2",
			"cache.operation": "get",
			"cache.result": "hit",
		}),
	}),
	row({
		spanId: "db-orders",
		startTime: at(22),
		parentSpanId: "pricing",
		spanName: "SELECT orders",
		spanKind: "SPAN_KIND_CLIENT",
		durationMs: 41,
		spanAttributes: JSON.stringify({
			"db.system.name": "postgresql",
			"db.operation.name": "SELECT",
			"db.collection.name": "orders",
			"db.response.returned_rows": "12",
		}),
	}),
	row({
		spanId: "charge",
		startTime: at(120),
		parentSpanId: "root",
		spanName: "POST",
		spanKind: "SPAN_KIND_CLIENT",
		durationMs: 210,
		spanAttributes: JSON.stringify({
			"http.request.method": "POST",
			"url.full": "https://api.stripe.com/v1/charges",
			"http.response.status_code": "201",
		}),
	}),
	row({
		spanId: "inventory",
		startTime: at(340),
		parentSpanId: "root",
		spanName: "GET",
		spanKind: "SPAN_KIND_CLIENT",
		durationMs: 87,
		statusCode: "Error",
		spanAttributes: JSON.stringify({
			"http.request.method": "GET",
			"url.full": "https://inventory.internal/v1/stock/sku-9182",
			"http.response.status_code": "503",
		}),
	}),
	row({
		spanId: "cache-miss",
		startTime: at(342),
		parentSpanId: "inventory",
		spanName: "cache.get stock",
		durationMs: 1,
		spanAttributes: JSON.stringify({
			"cache.system": "redis",
			"cache.name": "stock:sku-9182",
			"cache.operation": "get",
			"cache.result": "miss",
		}),
	}),
	row({
		spanId: "publish",
		startTime: at(430),
		parentSpanId: "root",
		spanName: "order.created publish",
		spanKind: "SPAN_KIND_PRODUCER",
		durationMs: 6,
	}),
	row({
		spanId: "consume",
		startTime: at(438),
		parentSpanId: "publish",
		spanName: "order.created process",
		serviceName: "email-worker",
		spanKind: "SPAN_KIND_CONSUMER",
		durationMs: 54,
	}),
	// three consecutive identical spans → one combined ×3 card
	...[1, 2, 3].map((i) =>
		row({
			spanId: `events-${i}`,
			startTime: at(440 + i * 20),
			parentSpanId: "consume",
			spanName: "INSERT events",
			serviceName: "email-worker",
			spanKind: "SPAN_KIND_CLIENT",
			durationMs: 9 + i * 4,
			spanAttributes: JSON.stringify({
				"db.system.name": "clickhouse",
				"db.operation.name": "INSERT",
				"db.collection.name": "events",
			}),
		}),
	),
	row({
		spanId: "serialize",
		startTime: at(470),
		parentSpanId: "root",
		spanName: "serialize response",
		durationMs: 3,
	}),
	// orphan → renders the missing-span placeholder as its parent
	row({
		spanId: "orphan",
		parentSpanId: "dropped-span-id",
		spanName: "LegacyAudit.record",
		serviceName: "audit",
		durationMs: 12,
	}),
]

function FlowLab() {
	const [selected, setSelected] = useState<SpanNode | undefined>(undefined)
	const detail = buildTraceDetail(ROWS)

	return (
		<DashboardLayout breadcrumbs={[{ label: "Flow Lab" }]}>
			<div className="flex h-full flex-col">
				<div className="border-b px-4 py-3">
					<h1 className="text-sm font-semibold">Flow Lab</h1>
					<p className="text-xs text-muted-foreground">
						Synthetic trace exercising every Flow view card variant. Selected:{" "}
						<span className="font-mono">{selected?.spanName ?? "none"}</span>
					</p>
				</div>
				<div className="min-h-0 flex-1">
					<TraceFlowView
						rootSpans={detail.rootSpans}
						totalDurationMs={detail.totalDurationMs}
						traceStartTime={detail.traceStartTime}
						services={detail.services}
						selectedSpanId={selected?.spanId}
						onSelectSpan={setSelected}
					/>
				</div>
			</div>
		</DashboardLayout>
	)
}
