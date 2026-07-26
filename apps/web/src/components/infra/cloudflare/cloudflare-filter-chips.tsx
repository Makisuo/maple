// Active-filter rail under the page hero.
//
// The sidebar collapses into a sheet below `lg`, so without this row there is
// no persistent answer to "what am I looking at". It also gives the per-panel
// scope markers something to refer back to.
//
// Deliberately built from the same vocabulary as `HeroChip` (mono 10px,
// rounded-sm, hairline border) so it reads as page furniture, not a widget.

import { useState } from "react"

import { XmarkIcon } from "@/components/icons"
import { activeFilterChips, type ActiveFilterChip, type CloudflareFilters } from "./filters"

const VISIBLE_LIMIT = 6

const CHIP_CLASS =
	"inline-flex items-center gap-1 rounded-sm border border-border/70 bg-background/60 py-0.5 pr-0.5 pl-1.5 font-mono text-[10px] text-muted-foreground"

export function CloudflareFilterChips({
	filters,
	onRemove,
	onClear,
}: {
	filters: CloudflareFilters
	onRemove: (chip: ActiveFilterChip) => void
	onClear: () => void
}) {
	const [expanded, setExpanded] = useState(false)
	const chips = activeFilterChips(filters)
	if (chips.length === 0) return null

	const visible = expanded ? chips : chips.slice(0, VISIBLE_LIMIT)
	const hidden = chips.length - visible.length

	return (
		<div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
			{visible.map((chip) => (
				<span key={`${chip.key}:${chip.value}`} className={CHIP_CLASS}>
					<span className="max-w-[22ch] truncate text-foreground/80">{chip.label}</span>
					<button
						type="button"
						onClick={() => onRemove(chip)}
						aria-label={`Remove ${chip.label}`}
						className="rounded-xs p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
					>
						<XmarkIcon size={9} />
					</button>
				</span>
			))}
			{hidden > 0 ? (
				<button
					type="button"
					onClick={() => setExpanded(true)}
					className="font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
				>
					+{hidden} more
				</button>
			) : null}
			<button
				type="button"
				onClick={onClear}
				className="ml-1 font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
			>
				Clear all
			</button>
		</div>
	)
}
