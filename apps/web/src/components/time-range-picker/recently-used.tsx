import type { RecentTimeRange } from "@/hooks/use-recently-used-times"
import { cn } from "@maple/ui/utils"

interface RecentlyUsedProps {
  recentTimes: RecentTimeRange[]
  onSelect: (item: RecentTimeRange) => void
}

export function RecentlyUsed({ recentTimes, onSelect }: RecentlyUsedProps) {
  if (recentTimes.length === 0) {
    return null
  }

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Recently Used
      </div>
      <div className="flex flex-col gap-0.5">
        {recentTimes.map((item, index) => (
          <button
            key={`${item.value}-${index}`}
            type="button"
            onClick={() => onSelect(item)}
            className={cn(
              "flex items-center gap-2 px-2 py-1 text-left text-xs hover:bg-muted transition-colors rounded-none"
            )}
          >
            <span className="text-muted-foreground">*</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
