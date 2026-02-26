import { useState } from "react"
import { cn } from "@maple/ui/lib/utils"
import { ChevronDownIcon, ChevronRightIcon, LoaderIcon } from "@/components/icons"

interface ToolCallDisplayProps {
  toolName: string
  state: string
  result?: unknown
}

const toolLabels: Record<string, string> = {
  system_health: "System Health",
  service_overview: "Service Overview",
  diagnose_service: "Diagnose Service",
  find_errors: "Find Errors",
  error_detail: "Error Detail",
  search_traces: "Search Traces",
  find_slow_traces: "Find Slow Traces",
  inspect_trace: "Inspect Trace",
  search_logs: "Search Logs",
  list_metrics: "List Metrics",
  query_data: "Query Data",
}

export function ToolCallDisplay({ toolName, state, result }: ToolCallDisplayProps) {
  const [expanded, setExpanded] = useState(false)
  const label = toolLabels[toolName] ?? toolName
  const isRunning = state === "call" || state === "partial-call"

  return (
    <div className="my-1.5 rounded-md border border-border/50 bg-background/50 text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted/50"
        onClick={() => setExpanded((v) => !v)}
      >
        {isRunning ? (
          <LoaderIcon className="size-3 animate-spin text-muted-foreground" />
        ) : expanded ? (
          <ChevronDownIcon className="size-3 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3 text-muted-foreground" />
        )}
        <span className={cn("font-medium", isRunning && "text-muted-foreground")}>
          {label}
        </span>
        {isRunning && (
          <span className="text-muted-foreground ml-auto">Running...</span>
        )}
      </button>
      {expanded && result != null && (
        <div className="border-t border-border/50 px-2 py-1.5">
          <pre className="max-h-60 overflow-auto text-[10px] text-muted-foreground whitespace-pre-wrap">
            {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
