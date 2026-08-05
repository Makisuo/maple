import { ToolbarSearch } from "@maple/ui/components/toolbar"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { BarsSortIcon, ChevronDownIcon } from "@/components/icons"
import { AGENT_TRACE_SORT_OPTIONS, type AgentTraceSort } from "./agent-traces-filter-inputs"

interface AgentTracesToolbarProps {
	query: string
	onSearch: (value: string | undefined) => void
	sort: AgentTraceSort
	onSortChange: (sort: AgentTraceSort) => void
}

/**
 * Search and the sort control, and nothing else.
 *
 * The triage chips that used to sit between them now live at the top of the
 * filter sidebar — every other filter on this page is there, and a row of
 * filters detached from the panel that owns the rest is two places to look for
 * one answer.
 *
 * Replays has no sort and doesn't need one — "longest session" is not a question
 * anyone asks. "What did we spend the most on yesterday" is, so agent traces gets
 * one, at the toolbar's right edge, opposite search.
 */
export function AgentTracesToolbar({ query, onSearch, sort, onSortChange }: AgentTracesToolbarProps) {
	const activeSort = AGENT_TRACE_SORT_OPTIONS.find((option) => option.key === sort)

	return (
		// Bare container rather than the shared `Toolbar`: this sits inside
		// `PageLayout.StickyArea`, which already supplies the border and padding.
		<div className="flex flex-wrap items-center gap-3">
			<ToolbarSearch
				query={query}
				onSearch={onSearch}
				placeholder="Search titles, agents, agent trace ids…"
				className="w-full sm:max-w-sm"
			/>

			<div className="ml-auto">
				<DropdownMenu>
					<DropdownMenuTrigger
						className="inline-flex h-8 items-center gap-1.75 rounded-md border border-border px-2.75 font-mono text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						aria-label="Sort agent traces"
					>
						<BarsSortIcon className="size-3.5 text-muted-foreground" />
						<span className="text-muted-foreground">Sort</span>
						<span className="text-foreground">{activeSort?.label}</span>
						<ChevronDownIcon className="size-2.5 text-muted-foreground" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuRadioGroup
							value={sort}
							onValueChange={(value) => onSortChange(value as AgentTraceSort)}
						>
							{AGENT_TRACE_SORT_OPTIONS.map((option) => (
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
