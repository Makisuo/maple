import { ToolbarSearch } from "@maple/ui/components/toolbar"
import { cn } from "@maple/ui/lib/utils"

interface ReplaysToolbarProps {
	/** Current `q` search param (URL substring filter). */
	query: string
	onSearch: (value: string | undefined) => void
	/** Facet count behind the one-click error filter chip. */
	errorSessions: number
	/** `hasErrors` URL filter state — the chip toggles it. */
	errorsOnly: boolean
	onToggleErrorsOnly: () => void
	/** "Engaged >30s" preset state (`activeMin === 30`) — the chip toggles it. */
	engagedOnly: boolean
	onToggleEngagedOnly: () => void
	/** Dim the chips while the list is refetching. */
	waiting?: boolean
}

/**
 * Search + one-click triage chips. The session/live totals live in the page
 * header; this row answers "what should I watch first" — errored sessions and
 * engaged sessions are each one click away.
 */
export function ReplaysToolbar({
	query,
	onSearch,
	errorSessions,
	errorsOnly,
	onToggleErrorsOnly,
	engagedOnly,
	onToggleEngagedOnly,
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
					<span className="tabular-nums">{errorSessions.toLocaleString()}</span> with errors
				</button>

				<button
					type="button"
					onClick={onToggleEngagedOnly}
					aria-pressed={engagedOnly}
					title="Sessions with more than 30s of active time"
					className={cn(
						"inline-flex h-7 items-center rounded-full border px-3 text-xs font-medium transition-colors",
						engagedOnly
							? "border-primary bg-accent text-accent-foreground"
							: "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
					)}
				>
					Engaged &gt;30s
				</button>
			</div>
		</div>
	)
}
