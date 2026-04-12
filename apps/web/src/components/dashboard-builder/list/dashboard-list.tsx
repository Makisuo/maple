import { useState, useMemo } from "react"

import { AlertWarningIcon, ArrowUpDownIcon, PlusIcon, StarIcon, StarFilledIcon, TrashIcon, XmarkIcon } from "@/components/icons"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@maple/ui/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Button } from "@maple/ui/components/ui/button"
import { Badge } from "@maple/ui/components/ui/badge"
import type { Dashboard, DashboardWidget } from "@/components/dashboard-builder/types"
import type { DashboardSortOption } from "@/atoms/dashboard-preferences-atoms"

const SORT_LABELS: Record<DashboardSortOption, string> = {
  updated: "Recently Updated",
  created: "Recently Created",
  "name-asc": "Name A\u2013Z",
  "name-desc": "Name Z\u2013A",
  widgets: "Most Widgets",
}

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

function DashboardPreview({ widgets }: { widgets: DashboardWidget[] }) {
  if (widgets.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-dim text-xs">
        No widgets
      </div>
    )
  }

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
        const gap = 3
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
  sortOption: DashboardSortOption
  tagFilter: string | null
  allTags: string[]
  favorites: Set<string>
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  onToggleFavorite: (id: string) => void
  onSortChange: (sort: DashboardSortOption) => void
  onTagFilterChange: (tag: string | null) => void
}

export function DashboardList({
  dashboards,
  readOnly = false,
  sortOption,
  tagFilter,
  allTags,
  favorites,
  onSelect,
  onCreate,
  onDelete,
  onToggleFavorite,
  onSortChange,
  onTagFilterChange,
}: DashboardListProps) {
  const [pendingDelete, setPendingDelete] = useState<Dashboard | null>(null)

  const favoriteDashboards = useMemo(
    () => dashboards.filter((d) => favorites.has(d.id)),
    [dashboards, favorites],
  )
  const otherDashboards = useMemo(
    () => dashboards.filter((d) => !favorites.has(d.id)),
    [dashboards, favorites],
  )

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-4">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" />
            }
          >
            <ArrowUpDownIcon size={14} data-icon="inline-start" />
            {SORT_LABELS[sortOption]}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              {(Object.keys(SORT_LABELS) as DashboardSortOption[]).map((key) => (
                <DropdownMenuItem
                  key={key}
                  onClick={() => onSortChange(key)}
                  className={sortOption === key ? "font-medium text-foreground" : ""}
                >
                  {SORT_LABELS[key]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {allTags.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm" />
              }
            >
              {tagFilter ? `Tag: ${tagFilter}` : "All Tags"}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Filter by tag</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => onTagFilterChange(null)}
                  className={tagFilter === null ? "font-medium text-foreground" : ""}
                >
                  All Tags
                </DropdownMenuItem>
                {allTags.map((tag) => (
                  <DropdownMenuItem
                    key={tag}
                    onClick={() => onTagFilterChange(tag)}
                    className={tagFilter === tag ? "font-medium text-foreground" : ""}
                  >
                    {tag}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {tagFilter && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onTagFilterChange(null)}
            className="text-dim"
          >
            <XmarkIcon size={14} data-icon="inline-start" />
            Clear filter
          </Button>
        )}
      </div>

      {/* Favorites section */}
      {favoriteDashboards.length > 0 && (
        <div className="mb-6">
          <h3 className="text-xs font-medium text-dim uppercase tracking-wider mb-3">Favorites</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {favoriteDashboards.map((dashboard) => (
              <DashboardCard
                key={dashboard.id}
                dashboard={dashboard}
                isFavorite
                readOnly={readOnly}
                onSelect={onSelect}
                onDelete={(d) => setPendingDelete(d)}
                onToggleFavorite={onToggleFavorite}
              />
            ))}
          </div>
        </div>
      )}

      {/* All / Other dashboards */}
      {favoriteDashboards.length > 0 && otherDashboards.length > 0 && (
        <h3 className="text-xs font-medium text-dim uppercase tracking-wider mb-3">All Dashboards</h3>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {otherDashboards.map((dashboard) => (
          <DashboardCard
            key={dashboard.id}
            dashboard={dashboard}
            isFavorite={false}
            readOnly={readOnly}
            onSelect={onSelect}
            onDelete={(d) => setPendingDelete(d)}
            onToggleFavorite={onToggleFavorite}
          />
        ))}

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

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <AlertWarningIcon className="text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete dashboard?</AlertDialogTitle>
            <AlertDialogDescription>
              "{pendingDelete?.name}" will be permanently deleted. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) onDelete(pendingDelete.id)
                setPendingDelete(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function DashboardCard({
  dashboard,
  isFavorite,
  readOnly,
  onSelect,
  onDelete,
  onToggleFavorite,
}: {
  dashboard: Dashboard
  isFavorite: boolean
  readOnly: boolean
  onSelect: (id: string) => void
  onDelete: (dashboard: Dashboard) => void
  onToggleFavorite: (id: string) => void
}) {
  return (
    <div
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
      <div className="h-[100px] w-full bg-background border-b border-border p-3">
        <DashboardPreview widgets={dashboard.widgets} />
      </div>
      <div className="flex flex-col gap-1.5 p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground truncate">
            {dashboard.name}
          </span>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              className={isFavorite ? "text-amber-500" : "opacity-0 group-hover:opacity-100 transition-opacity text-dim"}
              onClick={(e) => {
                e.stopPropagation()
                onToggleFavorite(dashboard.id)
              }}
            >
              {isFavorite ? <StarFilledIcon size={14} /> : <StarIcon size={14} />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={readOnly}
              className="opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(dashboard)
              }}
            >
              <TrashIcon size={14} />
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-dim">
          <span>
            {dashboard.widgets.length} widget
            {dashboard.widgets.length !== 1 ? "s" : ""}
          </span>
          <span>Updated {formatTimeAgo(dashboard.updatedAt)}</span>
        </div>
        {dashboard.tags && dashboard.tags.length > 0 && (
          <div className="flex items-center gap-1 mt-0.5">
            {dashboard.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-medium">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
