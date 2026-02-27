import { useState } from "react"
import { Button } from "@maple/ui/components/ui/button"
import {
  ChartBarIcon,
  CheckIcon,
  GridIcon,
  PulseIcon,
} from "@/components/icons"
import type {
  VisualizationType,
  WidgetDataSource,
  WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"

interface WidgetProposal {
  visualization: VisualizationType
  dataSource: WidgetDataSource
  display: WidgetDisplayConfig
}

interface WidgetProposalCardProps {
  input: WidgetProposal
  onAccept: () => void
}

const vizIcons: Record<string, typeof PulseIcon> = {
  stat: PulseIcon,
  chart: ChartBarIcon,
  table: GridIcon,
}

const vizLabels: Record<string, string> = {
  stat: "Stat",
  chart: "Chart",
  table: "Table",
}

export function WidgetProposalCard({ input, onAccept }: WidgetProposalCardProps) {
  const [added, setAdded] = useState(false)

  const Icon = vizIcons[input.visualization] ?? GridIcon
  const vizLabel = vizLabels[input.visualization] ?? input.visualization

  const handleAdd = () => {
    if (added) return
    onAccept()
    setAdded(true)
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/60 bg-muted/30 text-xs">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
          <Icon className="size-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-foreground">
            {input.display.title ?? "Untitled Widget"}
          </p>
          <p className="truncate text-muted-foreground">
            {vizLabel} &middot; {input.dataSource.endpoint}
          </p>
        </div>
        {added ? (
          <span className="flex items-center gap-1 text-emerald-600">
            <CheckIcon className="size-3.5" />
            Added
          </span>
        ) : (
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            onClick={handleAdd}
          >
            Add
          </Button>
        )}
      </div>
    </div>
  )
}
