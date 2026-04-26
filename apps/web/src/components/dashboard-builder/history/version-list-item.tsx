import { cn } from "@maple/ui/lib/utils"
import type {
  DashboardVersionChangeKind,
  DashboardVersionSummary,
} from "@maple/domain/http"
import { formatRelativeTime } from "@/lib/format"
import { ArrowPathIcon } from "@/components/icons"

const KIND_LABEL: Record<DashboardVersionChangeKind, string> = {
  created: "Created",
  renamed: "Renamed",
  description_changed: "Description",
  tags_changed: "Tags",
  time_range_changed: "Time range",
  widget_added: "Widget added",
  widget_removed: "Widget removed",
  widget_updated: "Widget updated",
  layout_changed: "Layout",
  restored: "Restored",
  multiple: "Edited",
}

// Marker color keyed off changeKind. Pulled from the existing chart/severity
// tokens so the timeline reads against the rest of the app.
const KIND_DOT: Record<DashboardVersionChangeKind, string> = {
  created: "bg-primary",
  renamed: "bg-chart-1",
  description_changed: "bg-chart-1",
  tags_changed: "bg-chart-1",
  time_range_changed: "bg-chart-2",
  widget_added: "bg-chart-3",
  widget_removed: "bg-severity-warn",
  widget_updated: "bg-chart-4",
  layout_changed: "bg-muted-foreground",
  restored: "bg-primary shadow-[0_0_0_3px_oklch(0.59_0.14_242/0.18)]",
  multiple: "bg-chart-5",
}

function actorInitials(userId: string): string {
  const trimmed = userId.trim()
  if (!trimmed) return "?"
  const upper = trimmed.toUpperCase()
  // Take first two alphanumerics — userIds are opaque, but this stays
  // deterministic across edits by the same person.
  const chars = upper.replace(/[^A-Z0-9]/g, "")
  return chars.slice(0, 2) || upper.slice(0, 2)
}

interface VersionListItemProps {
  version: DashboardVersionSummary
  isPreviewing: boolean
  isCurrent: boolean
  onPreview: () => void
}

export function VersionListItem({
  version,
  isPreviewing,
  isCurrent,
  onPreview,
}: VersionListItemProps) {
  const initials = actorInitials(version.createdBy)
  const summary = version.changeSummary ?? KIND_LABEL[version.changeKind]

  return (
    <li className="relative">
      <button
        type="button"
        onClick={onPreview}
        className={cn(
          "group relative w-full pl-7 pr-3 py-2.5 text-left transition-colors",
          "hover:bg-muted/40",
          isPreviewing && "bg-primary/5",
        )}
      >
        {/* Vertical rail accent for the active row */}
        {isPreviewing && (
          <span
            aria-hidden
            className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary"
          />
        )}

        {/* Marker dot anchored to the rail */}
        <span
          aria-hidden
          className={cn(
            "absolute left-[15px] top-[14px] block size-2 rounded-full ring-2 ring-background",
            KIND_DOT[version.changeKind],
          )}
        />

        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "text-[11px] font-medium uppercase tracking-wider",
                  isPreviewing
                    ? "text-primary"
                    : "text-muted-foreground/70 group-hover:text-foreground/80",
                )}
              >
                {KIND_LABEL[version.changeKind]}
              </span>
              {isCurrent && (
                <span className="rounded-sm bg-primary/10 px-1 py-px text-[9px] font-medium uppercase tracking-wider text-primary">
                  Current
                </span>
              )}
              {version.sourceVersionId && (
                <ArrowPathIcon
                  size={10}
                  className="text-muted-foreground"
                  aria-label="restored"
                />
              )}
            </div>
            <div className="mt-0.5 truncate text-[13px] leading-snug text-foreground">
              {summary}
            </div>
            <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
              <span
                aria-hidden
                className="grid size-3.5 place-items-center rounded-full bg-muted text-[8px] font-semibold uppercase text-muted-foreground"
              >
                {initials.slice(0, 1)}
              </span>
              <span>v{version.versionNumber}</span>
              <span aria-hidden className="opacity-50">·</span>
              <span>{formatRelativeTime(version.createdAt)}</span>
            </div>
          </div>
        </div>
      </button>
    </li>
  )
}
