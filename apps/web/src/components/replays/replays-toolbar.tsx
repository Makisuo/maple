import { ToolbarSearch, ToolbarStat } from "@maple/ui/components/toolbar"
import { cn } from "@maple/ui/utils"

interface ReplaysToolbarProps {
	/** Current `q` search param (URL substring filter). */
	query: string
	onSearch: (value: string | undefined) => void
	totalSessions: number
	activeSessions: number
	errorSessions: number
	/** Dim the stats while the list is refetching. */
	waiting?: boolean
}

export function ReplaysToolbar({
	query,
	onSearch,
	totalSessions,
	activeSessions,
	errorSessions,
	waiting = false,
}: ReplaysToolbarProps) {
	return (
		// Bare container rather than the shared `Toolbar`: this sits inside
		// `PageLayout.StickyArea`, which already supplies the border and padding.
		<div className="flex flex-wrap items-center justify-between gap-3">
			<ToolbarSearch
				query={query}
				onSearch={onSearch}
				placeholder="Search by URL…"
				className="w-full sm:max-w-sm"
			/>

			<div
				className={cn(
					"flex flex-wrap items-center gap-x-4 gap-y-1 transition-opacity",
					waiting && "opacity-60",
				)}
			>
				<ToolbarStat value={totalSessions} label="sessions" />
				<ToolbarStat value={activeSessions} label="active" dot />
				<ToolbarStat value={errorSessions} label="with errors" danger />
			</div>
		</div>
	)
}
