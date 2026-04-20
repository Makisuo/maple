import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"

import {
  ChartBarIcon,
  LayoutLeftIcon,
  MagnifierIcon,
  SidebarLeftIcon,
} from "@/components/icons"

export interface IssuesToolbarTab<T extends string> {
  value: T
  label: string
}

export interface IssuesToolbarProps<T extends string> {
  tabs: ReadonlyArray<IssuesToolbarTab<T>>
  active: T
  onChange: (value: T) => void
}

export function IssuesToolbar<T extends string>({
  tabs,
  active,
  onChange,
}: IssuesToolbarProps<T>) {
  return (
    <div className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
      <div
        role="tablist"
        aria-label="Filter issues"
        className="flex items-center gap-0.5"
      >
        {tabs.map((tab) => {
          const isActive = active === tab.value
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(tab.value)}
              className={cn(
                "inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors",
                isActive
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      <div className="ml-auto flex items-center gap-0.5">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Search"
          className="text-muted-foreground hover:text-foreground"
        >
          <MagnifierIcon size={14} />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Filter"
          className="text-muted-foreground hover:text-foreground"
        >
          <LayoutLeftIcon size={14} />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Chart view"
          className="text-muted-foreground hover:text-foreground"
        >
          <ChartBarIcon size={14} />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Toggle detail panel"
          className="text-muted-foreground hover:text-foreground"
        >
          <SidebarLeftIcon size={14} />
        </Button>
      </div>
    </div>
  )
}
