import * as React from "react"
import type { ReactNode } from "react"
import type { SpanNode } from "@/api/tinybird/traces"

interface TraceViewContextValue {
  rootSpans: SpanNode[]
  totalDurationMs: number
  traceStartTime: string
  services: string[]
  selectedSpanId?: string
  onSelectSpan?: (span: SpanNode) => void
}

const TraceViewContext = React.createContext<TraceViewContextValue | null>(null)

export function TraceViewProvider({
  children,
  ...value
}: TraceViewContextValue & { children: ReactNode }) {
  const ctx = React.useMemo(
    () => value,
    [
      value.rootSpans,
      value.totalDurationMs,
      value.traceStartTime,
      value.services,
      value.selectedSpanId,
      value.onSelectSpan,
    ],
  )
  return <TraceViewContext value={ctx}>{children}</TraceViewContext>
}

export function useTraceView() {
  const ctx = React.use(TraceViewContext)
  if (!ctx) throw new Error("useTraceView must be used within TraceViewProvider")
  return ctx
}
