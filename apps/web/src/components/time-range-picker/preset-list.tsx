import { PRESET_OPTIONS, type TimePreset } from "@/lib/time-utils"
import { cn } from "@maple/ui/utils"

interface PresetListProps {
  selectedValue?: string
  onSelect: (preset: TimePreset) => void
  onCustomClick: () => void
}

export function PresetList({ selectedValue, onSelect, onCustomClick }: PresetListProps) {
  return (
    <div className="flex flex-col">
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Presets
      </div>
      <div className="flex flex-col">
        {PRESET_OPTIONS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => onSelect(preset)}
            className={cn(
              "px-2 py-1.5 text-left text-xs hover:bg-muted transition-colors",
              selectedValue === preset.value && "bg-muted text-foreground font-medium"
            )}
          >
            {preset.label}
          </button>
        ))}
        <div className="h-px bg-border my-1" />
        <button
          type="button"
          onClick={onCustomClick}
          className="px-2 py-1.5 text-left text-xs hover:bg-muted transition-colors"
        >
          Custom
        </button>
      </div>
    </div>
  )
}
