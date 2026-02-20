import { PlusIcon, TrashIcon } from "@/components/icons"

import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@maple/ui/components/ui/card"
import { Button } from "@maple/ui/components/ui/button"
import type { Dashboard } from "@/components/dashboard-builder/types"

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
      <button
        type="button"
        onClick={onCreate}
        disabled={readOnly}
        className="ring-1 ring-dashed ring-border hover:ring-foreground/30 bg-card flex flex-col items-center justify-center gap-2 p-8 transition-all text-muted-foreground hover:text-foreground min-h-[140px] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <PlusIcon size={24} />
        <span className="text-xs font-medium">Create Dashboard</span>
      </button>

      {dashboards.map((dashboard) => (
        <Card
          key={dashboard.id}
          className="cursor-pointer hover:ring-foreground/20 transition-all"
        >
          <button
            type="button"
            className="w-full text-left"
            onClick={() => onSelect(dashboard.id)}
          >
            <CardHeader>
              <CardTitle>{dashboard.name}</CardTitle>
              <CardAction>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={readOnly}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(dashboard.id)
                  }}
                >
                  <TrashIcon size={14} />
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3 text-muted-foreground">
                <span>{dashboard.widgets.length} widget{dashboard.widgets.length !== 1 ? "s" : ""}</span>
                <span>
                  {new Date(dashboard.updatedAt).toLocaleDateString()}
                </span>
              </div>
            </CardContent>
          </button>
        </Card>
      ))}
    </div>
  )
}
