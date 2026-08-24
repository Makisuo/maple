import { useAtomRefresh, Result } from "@/lib/effect-atom"
import { cn } from "@maple/ui/lib/utils"
import { formatNumber } from "@maple/ui/lib/format"

import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { webAnalyticsLiveResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { AnalyticsFilters } from "./filters"

/**
 * Twice inside the server's 15s cache TTL, so a tab that stays open sees the
 * number move at the cadence the cache can actually deliver, and two tabs on the
 * same org mostly share entries instead of each paying for a scan.
 */
const POLL_MS = 15_000

/**
 * Visitors on the site right now.
 *
 * The one number on this page that is not about the selected time range — it
 * ignores the range entirely and always means "the last few minutes" — so it
 * sits apart from the range controls rather than inside the KPI strip, whose
 * every tile is read against the window in the picker.
 *
 * Silent about its own failures: it is a glance, not a readout. A failed poll
 * keeps the last number rather than putting an error where a count should be,
 * and a first load that fails renders nothing at all rather than an error state
 * beside a page that is otherwise fine.
 */
export function AnalyticsLiveBadge({ filters }: { filters: AnalyticsFilters }) {
	const atom = webAnalyticsLiveResultAtom({ data: { ...filters } })
	// Refreshable as well as self-polling: the header's reload button means "show
	// me now", and a badge that ignored it would sit on a number up to a poll old
	// while every other panel on the page had just moved.
	const result = useRefreshableAtomValue(atom)
	const refresh = useAtomRefresh(atom)

	useIntervalRefresh(refresh, { intervalMs: POLL_MS, enabled: true })

	return Result.builder(result)
		.onSuccess((live) => {
			// Visitor ids come from the migration-0011 analytics block, so an org on
			// an older SDK build reports none at all. Counting its active sessions
			// instead is the difference between "nobody is here" and the truth.
			const identified = live.visitors > 0
			const count = identified ? live.visitors : live.sessions
			const minutes = Math.max(1, Math.round(live.windowSeconds / 60))
			const noun = identified
				? count === 1
					? "visitor"
					: "visitors"
				: count === 1
					? "session"
					: "sessions"

			return (
				<span
					className={cn(
						"inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium tabular-nums",
						count > 0
							? "border-success/30 bg-success/10 text-success"
							: "border-border/70 text-muted-foreground",
					)}
					title={`${count} ${noun} active in the last ${minutes} minute${minutes === 1 ? "" : "s"}`}
				>
					<span className="relative inline-flex size-1.5">
						{count > 0 ? (
							<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
						) : null}
						<span
							className={cn(
								"relative inline-flex size-full rounded-full",
								count > 0 ? "bg-success" : "bg-muted-foreground/50",
							)}
						/>
					</span>
					<span aria-live="polite">
						{formatNumber(count)} <span className="hidden sm:inline">online</span>
					</span>
				</span>
			)
		})
		.orElse(() => null)
}
