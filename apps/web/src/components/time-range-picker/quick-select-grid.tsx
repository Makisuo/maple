import { QUICK_SELECT_OPTIONS, relativeToAbsolute } from "@/lib/time-utils"
import { useTimeFormat } from "@/hooks/use-time-format"

interface QuickSelectGridProps {
	onSelect: (range: { startTime: string; endTime: string }, value: string, label: string) => void
}

export function QuickSelectGrid({ onSelect }: QuickSelectGridProps) {
	const { timeZone } = useTimeFormat()
	return (
		<div className="space-y-2">
			<div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/80">
				Quick select
			</div>
			<div className="grid grid-cols-4 gap-1.5">
				{QUICK_SELECT_OPTIONS.map((option) => (
					<button
						key={option.value}
						type="button"
						onClick={() => {
							const range = relativeToAbsolute(option.value, timeZone)
							if (range) {
								onSelect(range, option.value, option.label)
							}
						}}
						className="flex h-7 items-center justify-center rounded-md border border-border/60 bg-background/30 font-mono text-[11px] tracking-wide text-foreground/90 transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{option.label}
					</button>
				))}
			</div>
		</div>
	)
}
