import { ToolbarSearch } from "@maple/ui/components/toolbar"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { cn } from "@maple/ui/lib/utils"
import { AGENT_SESSIONS_SORT_OPTIONS, type AgentSessionsSortOption } from "./agent-sessions-filter-inputs"

interface AgentSessionsToolbarProps {
	/** Current `q` search param (session / trace id prefix). */
	query: string
	onSearch: (value: string | undefined) => void
	/** `hasErrors` URL filter state — the chip toggles it. */
	errorsOnly: boolean
	onToggleErrorsOnly: () => void
	sortKey: string
	onSortChange: (option: AgentSessionsSortOption) => void
	/** Dim the controls while the list is refetching. */
	waiting?: boolean
}

/**
 * Search, the one-click error triage chip, and the sort. The session count
 * lives in the page header; this row answers "which of these first".
 */
export function AgentSessionsToolbar({
	query,
	onSearch,
	errorsOnly,
	onToggleErrorsOnly,
	sortKey,
	onSortChange,
	waiting = false,
}: AgentSessionsToolbarProps) {
	return (
		// Bare container rather than the shared `Toolbar`: this sits inside
		// `DashboardLayout.Sticky`, which already supplies the border and padding.
		<div className="flex flex-wrap items-center justify-between gap-3">
			<ToolbarSearch
				query={query}
				onSearch={onSearch}
				placeholder="Session or trace ID…"
				className="w-full sm:max-w-sm"
			/>

			<div
				className={cn(
					"flex flex-wrap items-center gap-2 transition-opacity",
					waiting && "opacity-60",
				)}
			>
				<button
					type="button"
					onClick={onToggleErrorsOnly}
					aria-pressed={errorsOnly}
					title={errorsOnly ? "Show all sessions" : "Show only sessions with errors"}
					className={cn(
						"inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
						errorsOnly
							? "border-destructive bg-destructive text-white"
							: "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15",
					)}
				>
					<span
						className={cn("size-1.5 rounded-full", errorsOnly ? "bg-white" : "bg-destructive")}
						aria-hidden
					/>
					With errors
				</button>

				<Select
					value={sortKey}
					onValueChange={(value) => {
						const option = AGENT_SESSIONS_SORT_OPTIONS.find(
							(candidate) => candidate.key === value,
						)
						if (option) onSortChange(option)
					}}
				>
					<SelectTrigger size="sm" className="h-7 w-40 text-xs" aria-label="Sort sessions">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{AGENT_SESSIONS_SORT_OPTIONS.map((option) => (
							<SelectItem key={option.key} value={option.key}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		</div>
	)
}
