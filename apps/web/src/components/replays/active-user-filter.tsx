import { XmarkIcon } from "@/components/icons"
import { formatCount } from "@/lib/format"
import { gradientFor } from "./replay-format"

interface ActiveUserFilterProps {
	/** The user id the list is currently scoped to. */
	userId: string
	/** Sessions loaded for this user in the active time range. */
	count: number
	onClear: () => void
}

/**
 * Active-scope banner shown above the session list when a UserID filter is set.
 * Makes the "viewing one person's sessions" state unmistakable at the point of
 * attention (the list), with a one-click clear — the sidebar field can scroll out
 * of view, this never does.
 */
export function ActiveUserFilter({ userId, count, onClear }: ActiveUserFilterProps) {
	const initial = (userId[0] ?? "?").toUpperCase()
	return (
		<div className="mb-3 flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2">
			<div
				className={`grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br ${gradientFor(userId)} text-xs font-semibold text-white shadow-sm`}
			>
				{initial}
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-baseline gap-2">
					<span className="text-xs text-muted-foreground">Sessions from</span>
					<span className="truncate font-mono text-sm font-medium" title={userId}>
						{userId}
					</span>
				</div>
				<span className="text-xs text-muted-foreground tabular-nums">
					{formatCount(count)} session{count === 1 ? "" : "s"} loaded
				</span>
			</div>
			<button
				type="button"
				onClick={onClear}
				aria-label="Clear user filter"
				className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<XmarkIcon className="size-4" />
			</button>
		</div>
	)
}
