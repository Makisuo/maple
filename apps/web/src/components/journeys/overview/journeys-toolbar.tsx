import { ToolbarSearch } from "@maple/ui/components/toolbar"
import { cn } from "@maple/ui/lib/utils"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { BarsSortIcon, ChevronDownIcon } from "@/components/icons"
import { COST_OUTLIER_DOLLARS, JOURNEY_SORT_OPTIONS, type JourneySort } from "./journeys-filter-inputs"

/** One triage chip: a named slice of the list, one click away, mirroring a
 *  sidebar facet so toggling either surface keeps the other in sync. */
interface QuickFilter {
	readonly key: string
	readonly label: string
	/** Omitted where the facets query has no count for this slice (cost bounds). */
	readonly count?: number
	readonly active: boolean
	readonly tone?: "destructive"
	readonly onToggle: () => void
	readonly title: string
}

interface JourneysToolbarProps {
	query: string
	onSearch: (value: string | undefined) => void
	/** Facet counts behind the chips. */
	erroredCount: number
	truncatedCount: number
	toolCount: number
	/** Current filter state, so each chip can show as pressed. */
	statusError: boolean
	truncatedOnly: boolean
	expensiveOnly: boolean
	usedTools: boolean
	onToggleStatusError: () => void
	onToggleTruncated: () => void
	onToggleExpensive: () => void
	onToggleUsedTools: () => void
	sort: JourneySort
	onSortChange: (sort: JourneySort) => void
	/** Dim the chips while the list is refetching. */
	waiting?: boolean
}

/**
 * Search, four triage chips, and the sort control.
 *
 * Replays has no sort and doesn't need one — "longest session" is not a question
 * anyone asks. "What did we spend the most on yesterday" is, so journeys gets
 * one, at the toolbar's right edge, opposite search, leaving the left to chips.
 */
export function JourneysToolbar({
	query,
	onSearch,
	erroredCount,
	truncatedCount,
	toolCount,
	statusError,
	truncatedOnly,
	expensiveOnly,
	usedTools,
	onToggleStatusError,
	onToggleTruncated,
	onToggleExpensive,
	onToggleUsedTools,
	sort,
	onSortChange,
	waiting = false,
}: JourneysToolbarProps) {
	const chips: ReadonlyArray<QuickFilter> = [
		{
			key: "errored",
			label: "Errored",
			count: erroredCount,
			active: statusError,
			tone: "destructive",
			onToggle: onToggleStatusError,
			title: "Journeys that ended in an error",
		},
		{
			key: "truncated",
			label: "Truncated",
			count: truncatedCount,
			active: truncatedOnly,
			onToggle: onToggleTruncated,
			title: "Journeys whose response hit the token cap — a silent failure",
		},
		{
			key: "expensive",
			label: `Over $${COST_OUTLIER_DOLLARS.toFixed(2)}`,
			active: expensiveOnly,
			onToggle: onToggleExpensive,
			title: `Journeys that cost more than $${COST_OUTLIER_DOLLARS.toFixed(2)}`,
		},
		{
			key: "tools",
			label: "Used tools",
			count: toolCount,
			active: usedTools,
			onToggle: onToggleUsedTools,
			title: "Journeys that executed at least one tool",
		},
	]

	const activeSort = JOURNEY_SORT_OPTIONS.find((option) => option.key === sort)

	return (
		// Bare container rather than the shared `Toolbar`: this sits inside
		// `PageLayout.StickyArea`, which already supplies the border and padding.
		<div className="flex flex-wrap items-center gap-3">
			<ToolbarSearch
				query={query}
				onSearch={onSearch}
				placeholder="Search titles, agents, journey ids…"
				className="w-full sm:max-w-sm"
			/>

			<div
				className={cn(
					"flex flex-wrap items-center gap-1.75 transition-opacity",
					waiting && "opacity-60",
				)}
			>
				{chips.map((chip) => (
					<button
						key={chip.key}
						type="button"
						onClick={chip.onToggle}
						aria-pressed={chip.active}
						title={chip.title}
						className={cn(
							"inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 font-mono text-xs transition-colors",
							chip.active
								? "border-primary bg-accent text-accent-foreground"
								: "border-border text-foreground/85 hover:bg-muted hover:text-foreground",
						)}
					>
						{chip.label}
						{chip.count != null && (
							<span
								className={cn(
									"tabular-nums",
									chip.active
										? "text-accent-foreground/70"
										: chip.tone === "destructive" && chip.count > 0
											? "text-destructive"
											: "text-muted-foreground",
								)}
							>
								{chip.count.toLocaleString()}
							</span>
						)}
					</button>
				))}
			</div>

			<div className="ml-auto">
				<DropdownMenu>
					<DropdownMenuTrigger
						className="inline-flex h-8 items-center gap-1.75 rounded-md border border-border px-2.75 font-mono text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						aria-label="Sort journeys"
					>
						<BarsSortIcon className="size-3.5 text-muted-foreground" />
						<span className="text-muted-foreground">Sort</span>
						<span className="text-foreground">{activeSort?.label}</span>
						<ChevronDownIcon className="size-2.5 text-muted-foreground" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuRadioGroup
							value={sort}
							onValueChange={(value) => onSortChange(value as JourneySort)}
						>
							{JOURNEY_SORT_OPTIONS.map((option) => (
								<DropdownMenuRadioItem key={option.key} value={option.key}>
									{option.label}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	)
}
