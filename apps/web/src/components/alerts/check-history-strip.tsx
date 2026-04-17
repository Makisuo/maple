import * as React from "react"
import type { AlertCheckDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { formatSignalValue } from "@/lib/alerts/form-utils"
import type { AlertSignalType } from "@maple/domain/http"

interface CheckHistoryStripProps {
  checks: ReadonlyArray<AlertCheckDocument>
  signalType: AlertSignalType
  className?: string
}

const statusColor = (check: AlertCheckDocument) => {
  if (check.status === "breached") return "bg-red-500"
  if (check.status === "healthy") return "bg-emerald-500"
  return "bg-amber-500"
}

export function CheckHistoryStrip({ checks, signalType, className }: CheckHistoryStripProps) {
  if (checks.length === 0) {
    return (
      <div className={cn("text-xs text-muted-foreground", className)}>
        No checks recorded yet.
      </div>
    )
  }

  const ordered = React.useMemo(
    () =>
      [...checks].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      ),
    [checks],
  )

  return (
    <div className={cn("flex items-center gap-[2px]", className)}>
      {ordered.map((check, idx) => {
        const key = `${check.timestamp}-${check.groupKey}-${idx}`
        const accent =
          check.incidentTransition === "opened"
            ? "ring-1 ring-offset-0 ring-red-400"
            : check.incidentTransition === "resolved"
              ? "ring-1 ring-offset-0 ring-emerald-400"
              : null
        return (
          <Tooltip key={key}>
            <TooltipTrigger
              render={
                <div
                  className={cn(
                    "h-6 flex-1 min-w-[3px] rounded-[1px]",
                    statusColor(check),
                    accent,
                  )}
                />
              }
            />
            <TooltipContent className="text-xs">
              <div className="font-mono">
                {new Date(check.timestamp).toLocaleString()}
              </div>
              <div>
                {check.status} · value{" "}
                {check.observedValue == null
                  ? "—"
                  : formatSignalValue(signalType, check.observedValue)}
                {" "}· threshold {formatSignalValue(signalType, check.threshold)}
              </div>
              {check.incidentTransition !== "none" && (
                <div className="text-[10px] uppercase tracking-wider mt-0.5">
                  incident {check.incidentTransition}
                </div>
              )}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
