import { cn } from "@maple/ui/lib/utils"
import type { HostStatus } from "../format"

const DOT_COLOR: Record<HostStatus, string> = {
  active: "bg-[var(--severity-info)]",
  idle: "bg-muted-foreground/60",
  down: "bg-[var(--severity-error)]",
}

const RING_COLOR: Record<HostStatus, string> = {
  active: "ring-[color-mix(in_oklab,var(--severity-info)_45%,transparent)]",
  idle: "ring-border",
  down: "ring-[color-mix(in_oklab,var(--severity-error)_45%,transparent)]",
}

interface SeverityDotProps {
  status: HostStatus
  size?: "sm" | "md"
  className?: string
}

export function SeverityDot({ status, size = "sm", className }: SeverityDotProps) {
  const dim = size === "sm" ? "size-1.5" : "size-2"
  const wrap = size === "sm" ? "size-2.5" : "size-3"
  return (
    <span
      className={cn(
        "relative inline-flex items-center justify-center rounded-full ring-1 ring-inset",
        wrap,
        RING_COLOR[status],
        className,
      )}
    >
      {status === "active" && (
        <span
          aria-hidden
          className={cn(
            "infra-pulse absolute inset-0 rounded-full",
            "bg-[color-mix(in_oklab,var(--severity-info)_55%,transparent)]",
          )}
        />
      )}
      <span className={cn("relative rounded-full", dim, DOT_COLOR[status])} />
    </span>
  )
}
