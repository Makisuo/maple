import { Link } from "@tanstack/react-router"
import { SeverityBadge } from "@/components/logs/severity-badge"
import type { InlineLogData } from "./types"

export function InlineLog({ data }: { data: InlineLogData }) {
  return (
    <div className="my-1 flex items-start gap-1.5 rounded-lg border border-border/40 bg-muted/30 px-3 py-2 text-[11px]">
      <SeverityBadge severity={data.severity} className="shrink-0" />
      {data.serviceName && (
        <span className="shrink-0 text-muted-foreground">
          {data.serviceName}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate" title={data.body}>
        {data.body}
      </span>
      {data.timestamp && (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {new Date(data.timestamp).toLocaleTimeString()}
        </span>
      )}
      {data.traceId && (
        <Link
          to="/traces/$traceId"
          params={{ traceId: data.traceId }}
          className="shrink-0 text-primary hover:underline"
          title={data.traceId}
        >
          trace
        </Link>
      )}
    </div>
  )
}
