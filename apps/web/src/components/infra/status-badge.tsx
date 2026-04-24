import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"
import { deriveHostStatus, type HostStatus } from "./format"

const STATUS_LABEL: Record<HostStatus, string> = {
  active: "Active",
  idle: "Idle",
  down: "Down",
}

const STATUS_CLASS: Record<HostStatus, string> = {
  active:
    "bg-[color-mix(in_oklab,var(--severity-info)_12%,transparent)] text-[var(--severity-info)] border-[color-mix(in_oklab,var(--severity-info)_30%,transparent)]",
  idle: "bg-muted text-muted-foreground border-transparent",
  down: "bg-destructive/15 text-destructive border-destructive/30",
}

interface HostStatusBadgeProps {
  lastSeen: string
  /**
   * Reference timestamp ("as of when") for status calculation. Defaults to
   * wall-clock now, but list pages should pass the query window's endTime so
   * badges reflect data freshness at fetch time — not the user's idle clock.
   */
  referenceTime?: string | number
  className?: string
}

export function HostStatusBadge({ lastSeen, referenceTime, className }: HostStatusBadgeProps) {
  const status = deriveHostStatus(lastSeen, referenceTime ?? Date.now())
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 px-2 py-0.5 text-[11px] font-medium tracking-wide",
        STATUS_CLASS[status],
        className,
      )}
    >
      <span className="relative flex size-1.5 items-center justify-center">
        {status === "active" && (
          <span className="absolute inline-flex size-2.5 animate-ping rounded-full bg-[var(--severity-info)] opacity-50" />
        )}
        <span
          className={cn(
            "relative inline-flex size-1.5 rounded-full",
            status === "active" && "bg-[var(--severity-info)]",
            status === "idle" && "bg-muted-foreground/60",
            status === "down" && "bg-destructive",
          )}
        />
      </span>
      {STATUS_LABEL[status]}
    </Badge>
  )
}
