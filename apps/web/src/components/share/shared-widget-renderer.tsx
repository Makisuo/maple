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
 *
 * What a tile *does* own is its width. The signed-in board's tiles measure
 * themselves (`useWidgetMaxDataPoints`) and send the result as `maxDataPoints`,
 * which picks a timeseries chart's auto bucket; a share tile measures itself
 * with the same hook and reports the value up to `useShareWidgetData`, which
 * sends it on that widget's request. Without this the board bucketed on the
 * width model and its share on the fixed 100-point policy — two curves for one
 * widget.
 */
import { createContext, memo, use, useEffect, useMemo, useRef, type ReactNode } from "react"

import type { WidgetDataState } from "@/components/dashboard-builder/types"
import {
	SparklineSeriesScope,
	type SparklineSeriesResolver,
} from "@/components/dashboard-builder/widgets/stat-widget"
import { visualizationFor } from "@/components/dashboard-builder/widgets/types"
import { WidgetTimeRangeProvider } from "@/components/dashboard-builder/widgets/widget-time-range-context"
import { shareTransform, type ShareWidget, type ShareWidgetRequestOptions } from "@/hooks/use-share-dashboard"
import { useMeasuredWidgetMaxDataPoints } from "@/hooks/use-widget-max-data-points"
import { toPanelType } from "@/lib/query-builder/panel-types"

const LOADING: WidgetDataState = { status: "loading" }

/**
 * A stat's sparkline on a share. The share transport does not yet address a
 * widget's sparkline separately from its headline (every outcome is keyed by
 * widget id alone), so until it does the sparkline reads as loading — an
 * empty trend line, never a fetch: without this scope `LiveStatSparkline`
 * would call `useWidgetDataSource`, which reads the dashboard time-range
 * scope this page does not mount, and the redacted sparkline source has no
 * query to run anyway.
 */
const sparklineSeriesLoading: SparklineSeriesResolver = () => LOADING

const ShareWidgetStatesContext = createContext<Readonly<Record<string, WidgetDataState>>>({})

/**
 * Where a mounted tile reports its request options (today: `maxDataPoints`).
 * `null` outside a provider — a tile rendered somewhere that does not fetch
 * (a test, a preview) simply has nothing to report to.
 */
export type ShareWidgetOptionsReporter = (widgetId: string, options: ShareWidgetRequestOptions) => void
const ShareWidgetOptionsReporterContext = createContext<ShareWidgetOptionsReporter | null>(null)

export function ShareWidgetOptionsReporterProvider({
	report,
	children,
}: {
	report: ShareWidgetOptionsReporter
	children: ReactNode
}) {
	return <ShareWidgetOptionsReporterContext value={report}>{children}</ShareWidgetOptionsReporterContext>
}

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

	// Only for `rowLimit`: the state itself is already renderer-ready.
	// `useShareWidgetData` unwraps the envelope and applies the transform
	// through the same `toReadyWidgetData` the signed-in hook uses, so nothing
	// here may re-shape it — a second pass is exactly how the two paths drift.
	const transform = useMemo(() => shareTransform(widget.dataSource.transform), [widget.dataSource])
	const dataState = states[widget.id] ?? LOADING

	// Measured on the tile's own element with the signed-in board's hook, so
	// the value — and the bucket it selects — is the one the board would send.
	// Reported only once measured: the tile's fetch is keyed on it, and a report
	// at the default width would cost one request there and a second at the
	// real one.
	const ref = useRef<HTMLDivElement>(null)
	const chartId = widget.display.chartId
	const maxDataPoints = useMeasuredWidgetMaxDataPoints(
		ref,
		toPanelType(widget.visualization, typeof chartId === "string" ? chartId : undefined),
	)
	const report = use(ShareWidgetOptionsReporterContext)
	// Layout → data sync: the fetch key for this tile depends on a DOM
	// measurement, which only exists after commit — the same pattern as the
	// width hook it consumes.
	useEffect(() => {
		if (maxDataPoints !== undefined) report?.(widget.id, { maxDataPoints })
	}, [report, widget.id, maxDataPoints])

	return (
		<div ref={ref} className="h-full w-full">
			{/* Pure display — the "this tile has its own window" badge. The share
			    document carries `timeRange`, and dropping it here would silently
			    misrepresent a pinned tile as being on the board's range. */}
			<WidgetTimeRangeProvider timeRange={widget.timeRange}>
				<SparklineSeriesScope resolve={sparklineSeriesLoading}>
					<Visualization
						dataState={dataState}
						display={widget.display}
						// Always "view": a share has no editing affordances to gate, and
						// passing anything else would surface them.
						mode="view"
						rowLimit={transform?.limit}
					/>
				</SparklineSeriesScope>
			</WidgetTimeRangeProvider>
		</div>
	)
})
