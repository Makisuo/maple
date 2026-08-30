import { formatNumber, formatPercent } from "@maple/ui/lib/format"

import { FaceRobotIcon } from "@/components/icons"
import type { WebAnalyticsSummary } from "@/api/warehouse/web-analytics"
import type { AnalyticsFilters } from "@/components/analytics/filters"

/**
 * Below this, the split is not worth a line: a handful of crawler sessions on a
 * site with real traffic moves no number anyone reads, and a permanent notice
 * about it is furniture. Above it, the gap between recorded sessions and people
 * is large enough that a reader comparing this page against another analytics
 * tool deserves to be told why the numbers differ.
 */
const NOTICE_THRESHOLD = 0.05

/**
 * How much of this window is crawlers, and what the page did about it.
 *
 * `mix` is deliberately not the page's own summary: it is the same query run
 * over every agent, so the share stays a property of the window rather than of
 * the current view. Reading it off the filtered summary would report 0% under
 * the default Humans filter — the one state where saying so matters most,
 * because that is when the page is quietly showing a smaller number than the
 * raw session count and owes the reader an explanation.
 *
 * Read-only. It carried its own "Show humans only" button for about an hour,
 * which put a control in the one place on the page that has none — every other
 * filter is set from the rail — and a ghost button floating at the right edge of
 * a banner is not what the rest of this page looks like.
 *
 * COVERAGE, and the copy is careful about it: this counts the crawlers that
 * executed the browser SDK. Non-executing fetchers — GPTBot, ClaudeBot,
 * PerplexityBot among them — never reach `session_replays` at all, so the claim
 * is "of recorded sessions", never "of traffic". See `ch/user-agent.ts`.
 */
export function AnalyticsBotNotice({
	mix,
	traffic,
}: {
	mix: WebAnalyticsSummary
	traffic: AnalyticsFilters["traffic"]
}) {
	if (mix.botShare === null || mix.botShare < NOTICE_THRESHOLD) return null

	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">
			<FaceRobotIcon size={14} className="shrink-0 text-muted-foreground" />
			<span className="text-foreground">
				{formatPercent(mix.botShare)} of recorded sessions are bots
			</span>
			<span>
				{formatNumber(mix.botSessions)} of {formatNumber(mix.sessions)} sessions came from crawlers or
				automated browsers, and are {excluded(traffic)}. Change that under Traffic in the sidebar.
			</span>
		</div>
	)
}

/** What the current Traffic setting did with them, in the sentence's own voice. */
function excluded(traffic: AnalyticsFilters["traffic"]): string {
	if (traffic === "bots") return "the only sessions counted below"
	if (traffic === "all") return "counted in every number below"
	return "excluded from every number below"
}
