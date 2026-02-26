import { useEffect, useRef, useState } from "react"
import {
  ChartBarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleWarningIcon,
  CircleXmarkIcon,
  ClockIcon,
  CodeIcon,
  DatabaseIcon,
  LoaderIcon,
  MagnifierIcon,
  NetworkNodesIcon,
  PulseIcon,
  ServerIcon,
} from "@/components/icons"
import type { IconComponent } from "@/components/icons"

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

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

const toolIcons: Record<string, IconComponent> = {
  system_health: PulseIcon,
  service_overview: ServerIcon,
  diagnose_service: MagnifierIcon,
  find_errors: CircleXmarkIcon,
  error_detail: CircleWarningIcon,
  search_traces: NetworkNodesIcon,
  find_slow_traces: ClockIcon,
  inspect_trace: MagnifierIcon,
  search_logs: DatabaseIcon,
  list_metrics: ChartBarIcon,
  query_data: CodeIcon,
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

type ToolStatus = "running" | "completed" | "error"

function deriveStatus(state: string): ToolStatus {
  switch (state) {
    case "output-available":
      return "completed"
    case "output-error":
    case "output-denied":
      return "error"
    default:
      return "running"
  }
}

function extractOutputText(output: unknown): string | null {
  if (output == null) return null

  // MCP format: { content: [{ type: "text", text: "..." }] }
  if (
    typeof output === "object" &&
    "content" in (output as Record<string, unknown>)
  ) {
    const content = (output as { content: unknown[] }).content
    if (Array.isArray(content)) {
      return content
        .filter(
          (c): c is { type: "text"; text: string } =>
            typeof c === "object" &&
            c != null &&
            "type" in c &&
            (c as { type: string }).type === "text" &&
            "text" in c
        )
        .map((c) => c.text)
        .join("\n")
    }
  }

  if (typeof output === "string") return output

  return JSON.stringify(output, null, 2)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ToolProps {
  toolName: string
  toolCallId: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
}

export function Tool(props: ToolProps) {
  const { toolName, state, input, output, errorText } = props
  const status = deriveStatus(state)
  const label = toolLabels[toolName] ?? toolName
  const Icon = toolIcons[toolName] ?? CodeIcon

  const [open, setOpen] = useState(true)
  const prevStatusRef = useRef(status)

  // Auto-open when the tool completes or errors
  useEffect(() => {
    if (
      prevStatusRef.current === "running" &&
      (status === "completed" || status === "error")
    ) {
      setOpen(true)
    }
    prevStatusRef.current = status
  }, [status])

  const hasInput =
    input != null &&
    typeof input === "object" &&
    Object.keys(input as Record<string, unknown>).length > 0
  const outputText = extractOutputText(output)
  const hasContent = hasInput || outputText != null || errorText != null

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/60 bg-muted/30 text-xs">
      {/* Header */}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
        onClick={() => hasContent && setOpen((v) => !v)}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{label}</span>

        <span className="ml-auto flex items-center gap-1.5">
          {status === "running" && (
            <>
              <span className="text-muted-foreground">Running...</span>
              <LoaderIcon className="size-3 animate-spin text-muted-foreground" />
            </>
          )}
          {status === "completed" && (
            <CircleCheckIcon className="size-3.5 text-emerald-500" />
          )}
          {status === "error" && (
            <CircleXmarkIcon className="size-3.5 text-destructive" />
          )}
          {hasContent &&
            (open ? (
              <ChevronDownIcon className="size-3 text-muted-foreground" />
            ) : (
              <ChevronRightIcon className="size-3 text-muted-foreground" />
            ))}
        </span>
      </button>

      {/* Content */}
      {open && hasContent && (
        <div className="border-t border-border/50">
          {/* Input */}
          {hasInput && (
            <div className="border-b border-border/40 px-3 py-2">
              <p className="mb-1 font-medium text-muted-foreground">
                Arguments
              </p>
              <div className="space-y-0.5">
                {Object.entries(input as Record<string, unknown>)
                  .filter(([, v]) => v != null)
                  .map(([key, value]) => (
                    <div key={key} className="flex gap-2">
                      <span className="shrink-0 text-muted-foreground">
                        {key}:
                      </span>
                      <span className="font-mono text-foreground">
                        {typeof value === "string"
                          ? value
                          : JSON.stringify(value)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Error */}
          {errorText != null && (
            <div className="px-3 py-2">
              <p className="mb-1 font-medium text-destructive">Error</p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-destructive/80">
                {errorText}
              </pre>
            </div>
          )}

          {/* Output */}
          {outputText != null && (
            <div className="px-3 py-2">
              <p className="mb-1 font-medium text-muted-foreground">Result</p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-muted-foreground">
                {outputText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
