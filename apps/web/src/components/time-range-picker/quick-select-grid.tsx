import { QUICK_SELECT_OPTIONS, relativeToAbsolute } from "@/lib/time-utils"
import { Button } from "@maple/ui/components/ui/button"

interface QuickSelectGridProps {
  onSelect: (range: { startTime: string; endTime: string }, value: string, label: string) => void
}

export function QuickSelectGrid({ onSelect }: QuickSelectGridProps) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Relative Times
      </div>
      <div className="grid grid-cols-3 gap-1">
        {QUICK_SELECT_OPTIONS.map((option) => (
          <Button
            key={option.value}
            variant="outline"
            size="xs"
            onClick={() => {
              const range = relativeToAbsolute(option.value)
              if (range) {
                onSelect(range, option.value, option.label)
              }
            }}
            className="font-mono"
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
