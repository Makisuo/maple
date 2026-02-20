import { useState } from "react"
import { Flamegraph } from "@maple/ui/components/traces/flamegraph"
import { TraceFlowView } from "@maple/ui/components/traces/flow-view"
import type { SpanNode } from "@maple/ui/types"

const BASE_TIME = "2024-01-15T14:23:01.000Z"

function t(offsetMs: number): string {
  return new Date(new Date(BASE_TIME).getTime() + offsetMs).toISOString()
}

const emptyAttrs: Record<string, string> = {}

function span(
  overrides: Partial<SpanNode> & Pick<SpanNode, "spanId" | "spanName" | "serviceName" | "durationMs" | "startTime">
): SpanNode {
  return {
    traceId: "a3f8c1d2e5b7f901",
    parentSpanId: "",
    spanKind: "SPAN_KIND_SERVER",
    statusCode: "Ok",
    statusMessage: "",
    spanAttributes: emptyAttrs,
    resourceAttributes: emptyAttrs,
    children: [],
    depth: 0,
    ...overrides,
  }
}

// Build the span tree (checkout flow)
const chargeCard = span({
  spanId: "span-7", spanName: "chargeCard", serviceName: "payment-svc",
  durationMs: 45, startTime: t(89), parentSpanId: "span-6",
  spanKind: "SPAN_KIND_INTERNAL", depth: 3,
})

const processPayment = span({
  spanId: "span-6", spanName: "processPayment", serviceName: "payment-svc",
  durationMs: 57, startTime: t(85), parentSpanId: "span-3",
  spanKind: "SPAN_KIND_CLIENT", depth: 2, children: [chargeCard],
})

const validateInventory = span({
  spanId: "span-4", spanName: "validateInventory", serviceName: "order-service",
  durationMs: 20, startTime: t(38), parentSpanId: "span-3",
  spanKind: "SPAN_KIND_INTERNAL", depth: 2,
})

const reserveItems = span({
  spanId: "span-5", spanName: "reserveItems", serviceName: "order-service",
  durationMs: 16, startTime: t(62), parentSpanId: "span-3",
  spanKind: "SPAN_KIND_INTERNAL", depth: 2,
})

const createOrder = span({
  spanId: "span-3", spanName: "createOrder", serviceName: "order-service",
  durationMs: 85, startTime: t(34), parentSpanId: "span-1",
  spanKind: "SPAN_KIND_SERVER", depth: 1,
  children: [validateInventory, reserveItems, processPayment],
})

const validateToken = span({
  spanId: "span-2", spanName: "validateToken", serviceName: "auth-service",
  durationMs: 24, startTime: t(6), parentSpanId: "span-1",
  spanKind: "SPAN_KIND_CLIENT", depth: 1,
})

const sendConfirmation = span({
  spanId: "span-8", spanName: "sendConfirmation", serviceName: "order-service",
  durationMs: 30, startTime: t(148), parentSpanId: "span-1",
  spanKind: "SPAN_KIND_CLIENT", depth: 1,
})

const rootSpan = span({
  spanId: "span-1", spanName: "POST /checkout", serviceName: "api-gateway",
  durationMs: 203, startTime: BASE_TIME, spanKind: "SPAN_KIND_SERVER",
  spanAttributes: { "http.method": "POST", "http.route": "/checkout", "http.status_code": "200" },
  depth: 0, children: [validateToken, createOrder, sendConfirmation],
})

const rootSpans: SpanNode[] = [rootSpan]
const services = ["api-gateway", "auth-service", "order-service", "payment-svc"]
const totalDurationMs = 203

type Tab = "flow" | "waterfall" | "flamegraph"

const tabLabels: Record<Tab, string> = {
  flow: "Flow",
  waterfall: "Waterfall",
  flamegraph: "Flamegraph",
}

// Flat span list for the waterfall view
const waterfallSpans = [
  { span: rootSpan, svc: "api-gateway", color: "chart-1" },
  { span: validateToken, svc: "auth-service", color: "chart-2" },
  { span: createOrder, svc: "order-service", color: "chart-3" },
  { span: validateInventory, svc: "order-service", color: "chart-3" },
  { span: reserveItems, svc: "order-service", color: "chart-3" },
  { span: processPayment, svc: "payment-svc", color: "chart-4" },
  { span: chargeCard, svc: "payment-svc", color: "chart-4" },
  { span: sendConfirmation, svc: "order-service", color: "chart-3" },
]

const colorMap: Record<string, string> = {
  "chart-1": "bg-chart-1",
  "chart-2": "bg-chart-2",
  "chart-3": "bg-chart-3",
  "chart-4": "bg-chart-4",
}

const textColorMap: Record<string, string> = {
  "chart-1": "text-chart-1",
  "chart-2": "text-chart-2",
  "chart-3": "text-chart-3",
  "chart-4": "text-chart-4",
}

function Waterfall({ selectedSpanId, onSelectSpan }: { selectedSpanId?: string; onSelectSpan: (s: SpanNode) => void }) {
  return (
    <div>
      {/* Column headers */}
      <div className="hidden sm:flex items-center text-[9px] text-muted-foreground border-b border-border bg-muted/30 px-4 py-1.5">
        <span className="w-28 md:w-36 shrink-0">Service</span>
        <span className="w-20 md:w-28 shrink-0">Span</span>
        <span className="flex-1">Timeline</span>
        <span className="w-14 text-right shrink-0">Duration</span>
        <span className="w-12 text-right shrink-0">Status</span>
      </div>

      {/* Span rows */}
      <div className="divide-y divide-border">
        {waterfallSpans.map(({ span: s, color }) => {
          const isSelected = selectedSpanId === s.spanId
          const startPct = ((new Date(s.startTime).getTime() - new Date(BASE_TIME).getTime()) / totalDurationMs) * 100
          const widthPct = (s.durationMs / totalDurationMs) * 100

          return (
            <div
              key={s.spanId}
              onClick={() => onSelectSpan(s)}
              className={`flex items-center px-4 py-1.5 text-[10px] transition-colors cursor-pointer ${
                isSelected ? "bg-primary/5 border-l-2 border-l-accent" : "hover:bg-muted/20"
              }`}
            >
              <div className="w-28 md:w-36 shrink-0 flex items-center gap-1" style={{ paddingLeft: `${s.depth * 12}px` }}>
                {s.depth > 0 && <span className="text-muted-foreground/30">{"\u2514"}</span>}
                <span className={`w-1.5 h-1.5 shrink-0 ${colorMap[color]}`} />
                <span className={`font-mono text-[9px] truncate ${textColorMap[color]}`}>{s.serviceName}</span>
              </div>
              <span className="w-20 md:w-28 shrink-0 text-muted-foreground font-mono text-[9px] truncate hidden sm:block">{s.spanName}</span>
              <div className="flex-1 relative h-4 mx-2 hidden sm:block">
                <div
                  className={`absolute top-0.5 h-3 ${colorMap[color]}`}
                  style={{ left: `${startPct}%`, width: `${widthPct}%` }}
                >
                  <span className="text-[8px] text-background px-1 leading-3 truncate block font-medium">{s.spanName}</span>
                </div>
              </div>
              <span className="w-14 text-right shrink-0 text-muted-foreground font-mono text-[9px]">
                {s.durationMs < 1000 ? `${s.durationMs.toFixed(1)}ms` : `${(s.durationMs / 1000).toFixed(2)}s`}
              </span>
              <span className="w-12 text-right shrink-0">
                <span className="text-[8px] px-1 py-0.5 bg-green-500/10 text-green-400">{s.statusCode}</span>
              </span>
            </div>
          )
        })}
      </div>

      {/* Time axis */}
      <div className="hidden sm:flex items-center justify-between px-4 py-2 border-t border-border bg-background">
        <span className="text-[8px] text-muted-foreground">0ms</span>
        <span className="text-[8px] text-muted-foreground">50ms</span>
        <span className="text-[8px] text-muted-foreground">100ms</span>
        <span className="text-[8px] text-muted-foreground">150ms</span>
        <span className="text-[8px] text-muted-foreground">203ms</span>
      </div>
    </div>
  )
}

export function TraceVisualization() {
  const [tab, setTab] = useState<Tab>("flow")
  const [selectedSpanId, setSelectedSpanId] = useState<string | undefined>()

  const handleSelectSpan = (s: SpanNode) => {
    setSelectedSpanId(s.spanId === selectedSpanId ? undefined : s.spanId)
  }

  return (
    <div className="border border-border bg-[var(--bg-elevated)] overflow-hidden">
      {/* Trace detail header */}
      <div className="px-4 py-3 border-b border-border bg-background">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>Traces</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-accent font-mono">a3f8c1d2</span>
          </div>
          <span className="text-[9px] text-muted-foreground border border-border px-2 py-0.5 font-mono">
            a3f8c1d2e5b7f901
          </span>
        </div>
        <div className="text-xs text-foreground font-medium mb-2">POST /checkout</div>
        <div className="text-[10px] text-muted-foreground mb-3">8 spans across 4 services</div>
        <div className="flex flex-wrap items-center gap-2">
          {services.map((svc, i) => (
            <span
              key={svc}
              className={`text-[9px] border border-border px-1.5 py-0.5 font-mono ${
                ["text-chart-1", "text-chart-2", "text-chart-3", "text-chart-4"][i]
              }`}
            >
              {svc}
            </span>
          ))}
          <span className="text-[9px] border border-border px-1.5 py-0.5 text-muted-foreground">203ms</span>
          <span className="text-[9px] px-1.5 py-0.5 bg-green-500/10 text-green-400">Ok</span>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0 border-b border-border bg-background px-4">
        {(["flow", "waterfall", "flamegraph"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-[10px] px-3 py-2 border-b-2 transition-colors ${
              tab === t
                ? "text-foreground font-medium border-accent"
                : "text-muted-foreground border-transparent hover:text-foreground"
            }`}
          >
            {tabLabels[t]}
          </button>
        ))}
      </div>

      {/* Visualization */}
      <div className={tab === "flow" ? "h-[500px]" : ""}>
        {tab === "flow" && (
          <TraceFlowView
            rootSpans={rootSpans}
            totalDurationMs={totalDurationMs}
            traceStartTime={BASE_TIME}
            services={services}
            selectedSpanId={selectedSpanId}
            onSelectSpan={handleSelectSpan}
          />
        )}
        {tab === "waterfall" && (
          <Waterfall selectedSpanId={selectedSpanId} onSelectSpan={handleSelectSpan} />
        )}
        {tab === "flamegraph" && (
          <Flamegraph
            rootSpans={rootSpans}
            totalDurationMs={totalDurationMs}
            traceStartTime={BASE_TIME}
            services={services}
            selectedSpanId={selectedSpanId}
            onSelectSpan={handleSelectSpan}
          />
        )}
      </div>
    </div>
  )
}
