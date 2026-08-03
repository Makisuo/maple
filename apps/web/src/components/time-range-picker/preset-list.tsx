import type { TimePreset } from "@/lib/time-utils"
import { cn } from "@maple/ui/lib/utils"

interface PresetListProps {
	selectedValue?: string
	onSelect: (preset: TimePreset) => void
	onCustomClick: () => void
	presets: ReadonlyArray<TimePreset>
}

export function PresetList({ selectedValue, onSelect, onCustomClick, presets }: PresetListProps) {
	return (
		<div className="flex h-full flex-col py-2">
			<div className="px-3 pb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/80">
				Presets
			</div>
			<div className="flex flex-col">
				{presets.map((preset) => {
					const active = selectedValue === preset.value
					return (
						<button
							key={preset.value}
							type="button"
							onClick={() => onSelect(preset)}
							className={cn(
								"relative flex h-7 items-center pl-3 pr-2 text-left text-xs transition-colors",
								"before:absolute before:inset-y-1 before:left-0 before:w-[2px] before:rounded-r before:bg-transparent before:transition-colors",
								"hover:bg-muted/50",
								active && "text-foreground before:bg-primary",
								!active && "text-foreground/80",
							)}
						>
							<span className={cn("tabular-nums", active && "font-medium")}>
								{preset.label}
							</span>
						</button>
					)
				})}
			</div>
			<div className="mx-3 mt-1 h-px bg-border/60" />
			<button
				type="button"
				onClick={onCustomClick}
				className="mt-1 flex h-7 items-center pl-3 pr-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
			>
				Custom range…
			</button>
		</div>
	)
}
