import type { ReactNode } from "react"

import { Separator } from "@maple/ui/components/ui/separator"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { cn } from "@maple/ui/utils"

interface FilterSidebarFrameProps {
  children: ReactNode
  sticky?: boolean
  waiting?: boolean
  className?: string
}

export function FilterSidebarFrame({
  children,
  sticky = false,
  waiting = false,
  className,
}: FilterSidebarFrameProps) {
  return (
    <div
      className={cn(
        "w-64 shrink-0 overflow-hidden border-l pl-4",
        sticky && "sticky top-0 self-start",
        waiting && "opacity-60",
        className
      )}
    >
      {children}
    </div>
  )
}

interface FilterSidebarHeaderProps {
  title?: string
  canClear?: boolean
  onClear?: () => void
}

export function FilterSidebarHeader({
  title = "Filters",
  canClear = false,
  onClear,
}: FilterSidebarHeaderProps) {
  return (
    <div className="flex items-center justify-between py-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {canClear && onClear && (
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-primary hover:underline"
        >
          Clear all
        </button>
      )}
    </div>
  )
}

export function FilterSidebarBody({ children }: { children: ReactNode }) {
  return (
    <>
      <Separator className="my-2" />
      <ScrollArea className="h-[calc(100vh-220px)]">
        <div className="space-y-1 pr-4">{children}</div>
      </ScrollArea>
    </>
  )
}

interface FilterSidebarLoadingProps {
  sectionCount?: number
  sticky?: boolean
}

export function FilterSidebarLoading({
  sectionCount = 3,
  sticky = false,
}: FilterSidebarLoadingProps) {
  return (
    <FilterSidebarFrame sticky={sticky}>
      <div className="flex items-center justify-between py-2">
        <Skeleton className="h-5 w-16" />
      </div>
      <Separator className="my-2" />
      <div className="space-y-4">
        {Array.from({ length: sectionCount }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}
      </div>
    </FilterSidebarFrame>
  )
}

interface FilterSidebarMessageProps {
  message: string
  sticky?: boolean
}

export function FilterSidebarError({
  message,
  sticky = false,
}: FilterSidebarMessageProps) {
  return (
    <FilterSidebarFrame sticky={sticky}>
      <FilterSidebarHeader />
      <Separator className="my-2" />
      <p className="text-sm text-muted-foreground py-4">{message}</p>
    </FilterSidebarFrame>
  )
}
