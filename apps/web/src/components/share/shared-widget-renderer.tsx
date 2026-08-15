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
import { createContext, memo, use, useMemo, type ReactNode } from "react"
import { WidgetDataSourceTransformSchema } from "@maple/widgets/dashboard"
import { Schema } from "effect"

import type { WidgetDataState } from "@/components/dashboard-builder/types"
import { visualizationFor } from "@/components/dashboard-builder/widgets/types"
import { WidgetTimeRangeProvider } from "@/components/dashboard-builder/widgets/widget-time-range-context"
import { applyTransform } from "@/hooks/use-widget-data"
import type { ShareWidget } from "@/hooks/use-share-dashboard"

const decodeTransform = Schema.decodeUnknownSync(WidgetDataSourceTransformSchema)

/**
 * The widget's transform, or nothing when it doesn't decode.
 *
 * Decoded here rather than in the share document's schema so a transform this
 * build doesn't recognise costs one tile its formatting instead of failing the
 * whole page — the same trade the section decode makes. `transform` is kept
 * deliberately loose on the wire (`Schema.Unknown`) for that reason.
 */
const shareTransform = (raw: unknown): typeof WidgetDataSourceTransformSchema.Type | undefined => {
	if (raw === undefined) return undefined
	try {
		return decodeTransform(raw)
	} catch {
		console.warn("[share] widget transform could not be decoded — rendering untransformed")
		return undefined
	}
}

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
	const Visualization = visualizationFor(widget.visualization)

	const transform = useMemo(() => shareTransform(widget.dataSource.transform), [widget.dataSource])

	// The server returns rows; the transform is what turns them into what the
	// renderer expects. Without it a stat gets its whole result set where a
	// single number belongs and formats it as an em dash — which is what a
	// shared board's stat tiles used to show, on every board.
	const dataState = useMemo<WidgetDataState>(() => {
		const state = states[widget.id] ?? { status: "loading" as const }
		if (state.status !== "ready" || transform === undefined) return state
		return { ...state, data: applyTransform(state.data, transform) }
	}, [states, widget.id, transform])

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
					rowLimit={transform?.limit}
				/>
			</WidgetTimeRangeProvider>
		</div>
	)
})
