import { cn } from "@maple/ui/lib/utils"
import { deriveHostStatus, type HostStatus } from "./format"
import { SeverityDot } from "./primitives/severity-dot"

const STATUS_LABEL: Record<HostStatus, string> = {
  active: "Active",
  idle: "Idle",
  down: "Down",
}

const STATUS_TEXT: Record<HostStatus, string> = {
  active: "text-[var(--severity-info)]",
  idle: "text-muted-foreground",
  down: "text-[var(--severity-error)]",
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
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[11px] font-medium",
        STATUS_TEXT[status],
        className,
      )}
    >
      <SeverityDot status={status} />
      {STATUS_LABEL[status]}
    </span>
  )
}
