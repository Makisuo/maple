import { Link } from "@tanstack/react-router"
import { cn } from "@maple/ui/utils"
import { formatDuration } from "@/lib/format"
import type { InlineTraceData } from "./types"

export function InlineTrace({ data }: { data: InlineTraceData }) {
  return (
    <Link
      to="/traces/$traceId"
      params={{ traceId: data.id }}
      className="my-1 flex items-center gap-2 rounded-lg border border-border/40 bg-muted/30 px-3 py-2 text-[11px] transition-colors hover:bg-muted/60"
    >
      <span className="font-mono text-primary">
        {data.id.slice(0, 12)}
      </span>
      {data.hasError && (
        <span className="inline-block size-1.5 rounded-full bg-severity-error" />
      )}
      <span className="min-w-0 truncate text-foreground">
        {data.name}
      </span>
      <span
        className={cn(
          "ml-auto shrink-0 font-mono",
          data.durationMs > 5000
            ? "text-severity-error"
            : data.durationMs > 1000
              ? "text-severity-warn"
              : "text-muted-foreground",
        )}
      >
        {formatDuration(data.durationMs)}
      </span>
      {data.spanCount != null && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {data.spanCount} spans
        </span>
      )}
      {data.services && data.services.length > 0 && (
        <div className="flex shrink-0 gap-1">
          {data.services.slice(0, 3).map((svc) => (
            <span
              key={svc}
              className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground"
            >
              {svc}
            </span>
          ))}
          {data.services.length > 3 && (
            <span className="text-[10px] text-muted-foreground">
              +{data.services.length - 3}
            </span>
          )}
        </div>
      )}
    </Link>
  )
}
