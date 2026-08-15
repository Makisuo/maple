/**
 * How a tile draws itself on a share link.
 *
 * The counterpart to `LiveWidgetRenderer`, and the differences are the whole
 * point of the split. Data arrives page-level, already fetched in batches by
 * `useShareWidgetData` — a share's document carries no data source to build a
 * request from — so a tile reads its own state out of a context instead of
 * owning a query.
 *
 * No `WidgetActionsProvider`, and deliberately not `WidgetActionsScope` with a
 * trimmed set either. Outside any provider `useWidgetActions()` returns `null`,
 * so `WidgetShell`'s `showMenu` is false and there is no kebab, no "Create
 * alert", no "Remove", and no navigation into authed routes. On a page served
 * without a session the safest action set is the empty one, and absence is how
 * you spell it. `WidgetActionsScope` stays the right hatch the day a share
 * wants a genuinely public action.
 *
 * Also no `useInViewportSticky`: its only job is gating `useWidgetData`'s lazy
 * fetch. Share data is batched whether or not a tile is on screen, so the
 * observer would gate nothing and cost a 200ms delay per tile.
 */
import { createContext, memo, use, type ReactNode } from "react"

import type { WidgetDataState } from "@/components/dashboard-builder/types"
import { visualizationFor } from "@/components/dashboard-builder/widgets/types"
import { WidgetTimeRangeProvider } from "@/components/dashboard-builder/widgets/widget-time-range-context"
import type { ShareWidget } from "@/hooks/use-share-dashboard"

const ShareWidgetStatesContext = createContext<Readonly<Record<string, WidgetDataState>>>({})

export function ShareWidgetStatesProvider({
	states,
	children,
}: {
	states: Readonly<Record<string, WidgetDataState>>
	children: ReactNode
}) {
	return <ShareWidgetStatesContext value={states}>{children}</ShareWidgetStatesContext>
}

export const SharedWidgetRenderer = memo(function SharedWidgetRenderer({ widget }: { widget: ShareWidget }) {
	const states = use(ShareWidgetStatesContext)
	const dataState = states[widget.id] ?? { status: "loading" as const }
	const Visualization = visualizationFor(widget.visualization)

	return (
		<div className="h-full w-full">
			{/* Pure display — the "this tile has its own window" badge. The share
			    document carries `timeRange`, and dropping it here would silently
			    misrepresent a pinned tile as being on the board's range. */}
			<WidgetTimeRangeProvider timeRange={widget.timeRange}>
				<Visualization
					dataState={dataState}
					display={widget.display}
					// Always "view": a share has no editing affordances to gate, and
					// passing anything else would surface them.
					mode="view"
					rowLimit={(widget.dataSource.transform as { limit?: number } | undefined)?.limit}
				/>
			</WidgetTimeRangeProvider>
		</div>
	)
})
