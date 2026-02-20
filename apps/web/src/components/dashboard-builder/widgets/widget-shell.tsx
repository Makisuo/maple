import type { ReactNode } from "react"
import { GripDotsIcon, TrashIcon, GearIcon, PencilIcon } from "@/components/icons"

import { Card, CardContent, CardHeader, CardTitle, CardAction } from "@maple/ui/components/ui/card"
import { Button } from "@maple/ui/components/ui/button"
import { Popover, PopoverTrigger, PopoverContent, PopoverHeader, PopoverTitle } from "@maple/ui/components/ui/popover"
import type { WidgetMode } from "@/components/dashboard-builder/types"

interface WidgetShellProps {
  title: string
  mode: WidgetMode
  onRemove?: () => void
  onConfigure?: () => void
  editPanel?: ReactNode
  contentClassName?: string
  children: ReactNode
}

export function WidgetShell({
  title,
  mode,
  onRemove,
  onConfigure,
  editPanel,
  contentClassName,
  children,
}: WidgetShellProps) {
  const isEditable = mode === "edit"
  const showActions = !!onConfigure || isEditable

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="border-b py-2">
        <div className="flex items-center gap-2">
          {isEditable && (
            <div className="widget-drag-handle cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground">
              <GripDotsIcon size={14} />
            </div>
          )}
          <CardTitle className="flex-1 truncate text-xs">
            {title}
          </CardTitle>
        </div>
        {showActions && (
          <CardAction>
            <div className="flex items-center gap-0.5">
              {onConfigure && (
                <Button variant="ghost" size="xs" onClick={onConfigure}>
                  <GearIcon size={14} />
                  Configure
                </Button>
              )}
              {isEditable && editPanel && (
                <Popover>
                  <PopoverTrigger
                    render={
                      <Button variant="ghost" size="icon-xs">
                        <PencilIcon size={14} />
                      </Button>
                    }
                  />
                  <PopoverContent align="end" className="w-64">
                    <div className="flex flex-col gap-3">
                      <PopoverHeader>
                        <PopoverTitle>Edit Widget</PopoverTitle>
                      </PopoverHeader>
                      {editPanel}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
              {isEditable && onRemove && (
                <Button variant="ghost" size="icon-xs" onClick={onRemove}>
                  <TrashIcon size={14} />
                </Button>
              )}
            </div>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className={contentClassName ?? "flex-1 min-h-0 p-2"}>
        {children}
      </CardContent>
    </Card>
  )
}

type ExplicitWidgetShellProps = Omit<WidgetShellProps, "mode">

export function EditableWidgetShell(props: ExplicitWidgetShellProps) {
  return <WidgetShell {...props} mode="edit" />
}

export function ReadonlyWidgetShell(props: ExplicitWidgetShellProps) {
  return <WidgetShell {...props} mode="view" />
}
