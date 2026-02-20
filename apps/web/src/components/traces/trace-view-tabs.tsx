import { MenuIcon, FireIcon, NetworkNodesIcon } from "@/components/icons"

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@maple/ui/components/ui/tabs"
import { SpanHierarchy } from "./span-hierarchy"
import { Flamegraph } from "./flamegraph"
import { TraceFlowView } from "./flow-view"
import type { SpanNode, Span } from "@/api/tinybird/traces"

interface TraceViewTabsProps {
  rootSpans: SpanNode[]
  spans: Span[]
  totalDurationMs: number
  traceStartTime: string
  services: string[]
  defaultExpandDepth?: number
  selectedSpanId?: string
  onSelectSpan?: (span: SpanNode) => void
}

export function TraceViewTabs({
  rootSpans,
  spans: _spans,
  totalDurationMs,
  traceStartTime,
  services,
  defaultExpandDepth = 2,
  selectedSpanId,
  onSelectSpan,
}: TraceViewTabsProps) {
  // _spans is reserved for future Flow view implementation
  return (
    <Tabs defaultValue="waterfall" className="flex flex-col h-full">
      <TabsList variant="line" className="shrink-0">
        <TabsTrigger value="waterfall">
          <MenuIcon size={14} />
          Waterfall
        </TabsTrigger>
        <TabsTrigger value="flamegraph">
          <FireIcon size={14} />
          Flamegraph
        </TabsTrigger>
        <TabsTrigger value="flow">
          <NetworkNodesIcon size={14} />
          Flow
        </TabsTrigger>
      </TabsList>

      <TabsContent value="waterfall" className="flex-1 min-h-0 overflow-auto">
        <SpanHierarchy
          rootSpans={rootSpans}
          totalDurationMs={totalDurationMs}
          traceStartTime={traceStartTime}
          defaultExpandDepth={defaultExpandDepth}
          selectedSpanId={selectedSpanId}
          onSelectSpan={onSelectSpan}
        />
      </TabsContent>

      <TabsContent value="flamegraph" className="flex-1 min-h-0 overflow-auto">
        <Flamegraph
          rootSpans={rootSpans}
          totalDurationMs={totalDurationMs}
          traceStartTime={traceStartTime}
          services={services}
          selectedSpanId={selectedSpanId}
          onSelectSpan={onSelectSpan}
        />
      </TabsContent>

      <TabsContent value="flow" className="flex-1 min-h-0">
        <TraceFlowView
          rootSpans={rootSpans}
          totalDurationMs={totalDurationMs}
          traceStartTime={traceStartTime}
          services={services}
          selectedSpanId={selectedSpanId}
          onSelectSpan={onSelectSpan}
        />
      </TabsContent>
    </Tabs>
  )
}
