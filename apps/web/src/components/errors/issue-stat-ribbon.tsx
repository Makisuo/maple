import type { ErrorIssueDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { formatRelativeTime } from "@/lib/format"

interface IssueStatRibbonProps {
  issue: ErrorIssueDocument
  totalInWindow: number
  className?: string
}

export function IssueStatRibbon({
  issue,
  totalInWindow,
  className,
}: IssueStatRibbonProps) {
  const tiles: ReadonlyArray<StatTileProps> = [
    {
      label: "Events (total)",
      value: issue.occurrenceCount.toLocaleString(),
      accent: "bg-primary",
    },
    {
      label: "Events (window)",
      value: totalInWindow.toLocaleString(),
      accent: "bg-blue-500",
    },
    {
      label: "First seen",
      value: formatRelativeTime(issue.firstSeenAt),
      title: new Date(issue.firstSeenAt).toLocaleString(),
      accent: "bg-violet-500",
    },
    {
      label: "Last seen",
      value: formatRelativeTime(issue.lastSeenAt),
      title: new Date(issue.lastSeenAt).toLocaleString(),
      accent: "bg-amber-500",
    },
  ]
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-md bg-border/60 sm:grid-cols-4",
        className,
      )}
    >
      {tiles.map((tile) => (
        <StatTile key={tile.label} {...tile} />
      ))}
    </div>
  )
}

interface StatTileProps {
  label: string
  value: string
  accent: string
  title?: string
}

export function StatTile({ label, value, accent, title }: StatTileProps) {
  return (
    <div
      title={title}
      className="relative flex items-center gap-3 bg-card/60 px-4 py-3"
    >
      <span
        aria-hidden
        className={cn("h-7 w-[3px] shrink-0 rounded-full", accent)}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </span>
        <span className="truncate text-lg font-semibold tabular-nums text-foreground">
          {value}
        </span>
      </div>
    </div>
  )
}
