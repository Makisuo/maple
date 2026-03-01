import { Badge } from "@maple/ui/components/ui/badge"

export const METHOD_COLORS: Record<string, string> = {
  GET: "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400",
  POST: "bg-blue-500/10 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400",
  PUT: "bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400",
  PATCH: "bg-orange-500/10 text-orange-600 dark:bg-orange-400/10 dark:text-orange-400",
  DELETE: "bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400",
}

export function MethodBadge({ method, className }: { method: string; className?: string }) {
  const colorClass = METHOD_COLORS[method.toUpperCase()] ?? ""
  return (
    <Badge variant="secondary" className={`font-mono text-[11px] ${colorClass} ${className ?? ""}`}>
      {method}
    </Badge>
  )
}
