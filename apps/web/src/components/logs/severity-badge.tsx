import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/utils"

interface SeverityBadgeProps {
  severity: string
  className?: string
}

const severityStyles: Record<string, string> = {
  TRACE: "bg-gray-500/10 text-gray-500 dark:bg-gray-400/10 dark:text-gray-400",
  DEBUG: "bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400",
  INFO: "bg-green-500/10 text-green-600 dark:bg-green-400/10 dark:text-green-400",
  WARN: "bg-yellow-500/10 text-yellow-600 dark:bg-yellow-400/10 dark:text-yellow-400",
  WARNING: "bg-yellow-500/10 text-yellow-600 dark:bg-yellow-400/10 dark:text-yellow-400",
  ERROR: "bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400",
  FATAL: "bg-red-700/10 text-red-700 dark:bg-red-500/10 dark:text-red-500",
}

export function SeverityBadge({ severity, className }: SeverityBadgeProps) {
  const normalizedSeverity = severity.toUpperCase()
  const style = severityStyles[normalizedSeverity] ?? severityStyles.INFO

  return (
    <Badge
      variant="secondary"
      className={cn(
        "font-mono text-[10px] uppercase",
        style,
        className
      )}
    >
      {severity}
    </Badge>
  )
}
