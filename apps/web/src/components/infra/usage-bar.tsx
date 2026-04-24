import { cn } from "@maple/ui/lib/utils"
import { formatPercent, severityLevel, type SeverityLevel } from "./format"

interface UsageBarProps {
  fraction: number
  className?: string
  showValue?: boolean
}

const FILL_BY_LEVEL: Record<SeverityLevel, string> = {
  ok: "bg-[var(--severity-info)]",
  warn: "bg-[var(--severity-warn)]",
  crit: "bg-[var(--severity-error)]",
}

const TRACK_BY_LEVEL: Record<SeverityLevel, string> = {
  ok: "bg-[color-mix(in_oklab,var(--severity-info)_14%,transparent)]",
  warn: "bg-[color-mix(in_oklab,var(--severity-warn)_14%,transparent)]",
  crit: "bg-[color-mix(in_oklab,var(--severity-error)_18%,transparent)]",
}

const VALUE_BY_LEVEL: Record<SeverityLevel, string> = {
  ok: "text-foreground/80",
  warn: "text-[var(--severity-warn)]",
  crit: "text-[var(--severity-error)]",
}

export function UsageBar({ fraction, className, showValue = true }: UsageBarProps) {
  const safe = Number.isFinite(fraction) ? fraction : 0
  const clamped = Math.max(0, Math.min(1, safe))
  const level = severityLevel(clamped)

  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div
        className={cn(
          "relative h-2 flex-1 overflow-hidden rounded-full ring-1 ring-inset ring-border/40",
          TRACK_BY_LEVEL[level],
        )}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            FILL_BY_LEVEL[level],
          )}
          style={{ width: `${Math.max(clamped * 100, clamped > 0 ? 2 : 0)}%` }}
        />
      </div>
      {showValue && (
        <span
          className={cn(
            "font-mono text-[11px] tabular-nums w-10 text-right",
            VALUE_BY_LEVEL[level],
          )}
        >
          {formatPercent(fraction)}
        </span>
      )}
    </div>
  )
}
