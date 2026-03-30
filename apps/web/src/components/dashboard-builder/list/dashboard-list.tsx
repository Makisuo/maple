import { PlusIcon, TrashIcon } from "@/components/icons"

import { Button } from "@maple/ui/components/ui/button"
import type { Dashboard, DashboardWidget } from "@/components/dashboard-builder/types"

function formatTimeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return "Just now"
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  return new Date(dateStr).toLocaleDateString()
}

/** Renders a miniature silhouette of the dashboard's widget layout */
function DashboardPreview({ widgets }: { widgets: DashboardWidget[] }) {
  if (widgets.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-dim text-xs">
        No widgets
      </div>
    )
  }

  // Find the grid bounds
  const maxX = Math.max(...widgets.map((w) => (w.layout?.x ?? 0) + (w.layout?.w ?? 4)))
  const maxY = Math.max(...widgets.map((w) => (w.layout?.y ?? 0) + (w.layout?.h ?? 4)))
  const cols = Math.max(maxX, 12)
  const rows = Math.max(maxY, 4)

  return (
    <div className="relative w-full h-full">
      {widgets.map((widget) => {
        const x = widget.layout?.x ?? 0
        const y = widget.layout?.y ?? 0
        const w = widget.layout?.w ?? 4
        const h = widget.layout?.h ?? 4
        const gap = 3 // px gap between widgets
        const left = `calc(${(x / cols) * 100}% + ${gap}px)`
        const top = `calc(${(y / rows) * 100}% + ${gap}px)`
        const width = `calc(${(w / cols) * 100}% - ${gap * 2}px)`
        const height = `calc(${(h / rows) * 100}% - ${gap * 2}px)`

        const color =
          widget.visualization === "chart"
            ? "bg-primary/25"
            : widget.visualization === "stat"
              ? "bg-primary/20"
              : "bg-muted/30"

        return (
          <div
            key={widget.id}
            className={`absolute rounded-sm ${color}`}
            style={{ left, top, width, height }}
          >
            <div className="w-full h-full rounded-sm" />
          </div>
        )
      })}
    </div>
  )
}

interface DashboardListProps {
  dashboards: Dashboard[]
  readOnly?: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}

export function DashboardList({
  dashboards,
  readOnly = false,
  onSelect,
  onCreate,
  onDelete,
}: DashboardListProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {dashboards.map((dashboard) => (
        <div
          key={dashboard.id}
          role="button"
          tabIndex={0}
          className="group ring-1 ring-border hover:ring-border-active bg-card text-left transition-all flex flex-col overflow-hidden rounded-md cursor-pointer"
          onClick={() => onSelect(dashboard.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              onSelect(dashboard.id)
            }
          }}
        >
          {/* Preview thumbnail */}
          <div className="h-[100px] w-full bg-background border-b border-border p-3">
            <DashboardPreview widgets={dashboard.widgets} />
          </div>
          {/* Card body */}
          <div className="flex flex-col gap-1.5 p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground truncate">
                {dashboard.name}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={readOnly}
                className="opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(dashboard.id)
                }}
              >
                <TrashIcon size={14} />
              </Button>
            </div>
            <div className="flex items-center gap-3 text-xs text-dim">
              <span>
                {dashboard.widgets.length} widget
                {dashboard.widgets.length !== 1 ? "s" : ""}
              </span>
              <span>Updated {formatTimeAgo(dashboard.updatedAt)}</span>
            </div>
          </div>
        </div>
      ))}

      {/* Create button */}
      <button
        type="button"
        onClick={onCreate}
        disabled={readOnly}
        className="ring-1 ring-dashed ring-border hover:ring-border-active bg-card/50 flex flex-col items-center justify-center gap-2 p-8 transition-all text-dim hover:text-foreground min-h-[160px] disabled:opacity-50 disabled:cursor-not-allowed rounded-md"
      >
        <PlusIcon size={24} />
        <span className="text-xs font-medium">Create Dashboard</span>
      </button>
    </div>
  )
}
