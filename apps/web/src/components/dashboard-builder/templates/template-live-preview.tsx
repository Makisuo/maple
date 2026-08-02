import { memo, useDeferredValue, useMemo, useRef, useState } from "react"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/utils"
import { useContainerSize } from "@maple/ui/hooks/use-container-size"
import type { V2DashboardTemplate } from "@maple/domain/http/v2"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { DashboardTimeRangeWrapper } from "@/components/dashboard-builder/dashboard-providers"
import { visualizationFor } from "@/components/dashboard-builder/widgets/types"
import { WidgetTimeRangeProvider } from "@/components/dashboard-builder/widgets/widget-time-range-context"
import type { DashboardWidget, TimeRange } from "@/components/dashboard-builder/types"
import { useWidgetData } from "@/hooks/use-widget-data"
import { CircleWarningIcon } from "@/components/icons"

import { CANONICAL_COLS, colsForWidth } from "@/components/dashboard-builder/canvas/grid-breakpoints"

/** The 12-column grid every template lays its widgets out on. */

/**
 * Pixels per layout row unit. Templates are authored for a full dashboard, so
 * the preview shrinks them — but not below the floor each visualization needs
 * to stay legible. Charts scaled purely by row unit lose their plot area and
 * render as a bare axis; stats clip their value. The floors below are what each
 * visualization needs to actually show something.
 *
 * The canvas draws a row unit at 60px plus a 12px margin (`dashboard-canvas`),
 * so 32 plus the 8px grid gap below is a little over half scale. Enough that a
 * deliberately tall widget still reads as taller than its neighbours, rather
 * than every widget bottoming out on its floor.
 */
const ROW_HEIGHT = 32

/**
 * What `WidgetShell`'s `Card` costs before the visualization gets a pixel:
 * `CardHeader py-2.5` around a text-xs title, plus `CardContent p-2`. Measured,
 * not derived — the header's line box rounds up. Every floor below is this plus
 * what the visualization itself needs.
 */
const CARD_CHROME = 58

/** Minimum rendered height per visualization, in pixels. */
const MIN_HEIGHT: Record<string, number> = {
	// Value (text-2xl, 32) over a sparkline (h-10, 40) with the content's pt-4.
	// Within a few px of what the canvas gives the `h: 2` stats templates author,
	// so the preview isn't lying about the row it draws.
	stat: CARD_CHROME + 80,
	gauge: CARD_CHROME + 108,
	markdown: CARD_CHROME + 28,
}
/**
 * Charts and the table/list family. The two terms are the chart box's whole
 * budget: a 128px plot, comfortably clear of `MIN_CHART_PLOT_HEIGHT` (100), and
 * a legend at the 94px its widest form wants (it caps at 12 series, so four
 * wrapped rows is the worst case). Sized this way `responsiveLegendHeight`'s
 * 45%-of-box cap never binds, so the legend is never handed less than it asked
 * for and its last row is never sliced in half by the card edge — which is what
 * the preview did at every size before.
 */
const MIN_HEIGHT_DEFAULT = CARD_CHROME + 128 + 94

/**
 * Widgets drawn beyond this point are not worth the warehouse round trip in a
 * preview pane — the reader has already seen what the dashboard is. The list
 * says how many were left out rather than silently truncating.
 */
const MAX_PREVIEW_WIDGETS = 8

/** How long a template must stay selected before its preview queries anything. */
const SELECTION_DEBOUNCE_MS = 250

/** Stands in while the selection debounce is still running — issues no request. */
const idlePreviewAtom = Atom.make(Result.initial())

const heightFor = (widget: DashboardWidget): number =>
	Math.max(widget.layout.h * ROW_HEIGHT, MIN_HEIGHT[widget.visualization] ?? MIN_HEIGHT_DEFAULT)

/**
 * One widget, evaluated against the org's own data.
 *
 * Renders the visualization directly rather than through `WidgetShell` — the
 * preview has no drag handles, no actions menu and no dashboard to mutate. This
 * is the same shape the widget builder's live preview uses; `useWidgetData`
 * needs nothing but a surrounding `DashboardTimeRangeWrapper`.
 */
const PreviewWidget = memo(function PreviewWidget({
	widget,
	cols,
}: {
	widget: DashboardWidget
	cols: number
}) {
	const { dataState } = useWidgetData(widget)
	const Visualization = visualizationFor(widget.visualization)

	return (
		// Placement only, no chrome: `WidgetShell` already renders the tile as a
		// `Card`, so a bordered wrapper here would plate every widget twice.
		<div
			className="min-w-0"
			style={{
				gridColumn: `span ${Math.min(widget.layout.w, cols)}`,
				height: heightFor(widget),
			}}
		>
			<WidgetTimeRangeProvider timeRange={widget.timeRange}>
				<Visualization dataState={dataState} display={widget.display} mode="view" />
			</WidgetTimeRangeProvider>
		</div>
	)
})

/**
 * This preview is a plain CSS grid rather than a react-grid-layout instance, so
 * it can't inherit the canvas's generated breakpoint layouts. It resolves the
 * column count itself from the same `GRID_BREAKPOINTS` table, so a template
 * previewed on a phone collapses the same way the real dashboard will — a
 * 12-column preview inside a 375px dialog is unreadable.
 */
function PreviewGrid({ widgets }: { widgets: DashboardWidget[] }) {
	const ref = useRef<HTMLDivElement>(null)
	const { width } = useContainerSize(ref)
	// Before the first measurement, assume the full grid: templates are usually
	// previewed on a desktop, so this is the no-flash default.
	const cols = width > 0 ? colsForWidth(width) : CANONICAL_COLS

	return (
		<div ref={ref} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
			{widgets.map((widget) => (
				<PreviewWidget key={widget.id} widget={widget} cols={cols} />
			))}
		</div>
	)
}

/**
 * The shape most templates open with — a row of stats over a pair of charts —
 * drawn at the heights the real widgets will take, so the panel below the
 * preview doesn't jump when the request resolves.
 */
function PreviewSkeleton() {
	const statHeight = MIN_HEIGHT.stat
	return (
		<div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${CANONICAL_COLS}, 1fr)` }}>
			<Skeleton className="col-span-4 rounded-md" style={{ height: statHeight }} />
			<Skeleton className="col-span-4 rounded-md" style={{ height: statHeight }} />
			<Skeleton className="col-span-4 rounded-md" style={{ height: statHeight }} />
			<Skeleton className="col-span-6 rounded-md" style={{ height: MIN_HEIGHT_DEFAULT }} />
			<Skeleton className="col-span-6 rounded-md" style={{ height: MIN_HEIGHT_DEFAULT }} />
		</div>
	)
}

interface TemplateLivePreviewProps {
	template: V2DashboardTemplate
	/** Current parameter form values; the preview rebuilds as they change. */
	parameters: Readonly<Record<string, string>>
	className?: string
}

/**
 * The dashboard this template would build, drawn with the org's real data.
 *
 * This is the panel's central claim — "that's the dashboard you'd get right
 * now" — so it renders the actual widgets rather than a wireframe, including
 * for templates whose data hasn't arrived. Their widgets' own empty states say
 * so more precisely than a placeholder could, and a readiness false negative
 * (the check only looks back 24 h) shows up here instead of being hidden.
 */
export function TemplateLivePreview({ template, parameters, className }: TemplateLivePreviewProps) {
	// A preview is one warehouse request per widget, so arrowing down the list
	// would fan out a full dashboard's worth of queries per row passed over. The
	// component is remounted per template, so a mount-timer debounces selection:
	// a preview that is replaced before the delay elapses never fetches at all.
	const [armed, setArmed] = useState(false)
	useMountEffect(() => {
		const timer = setTimeout(() => setArmed(true), SELECTION_DEBOUNCE_MS)
		return () => clearTimeout(timer)
	})

	// Trail parameter typing rather than firing a build per keystroke.
	const deferredParameters = useDeferredValue(parameters)

	const payload = useMemo(() => {
		const entries = Object.entries(deferredParameters).filter(([, value]) => value.trim().length > 0)
		return entries.length > 0 ? { parameters: Object.fromEntries(entries) } : {}
	}, [deferredParameters])

	const result = useAtomValue(
		armed
			? MapleApiV2AtomClient.query("dashboards", "previewTemplate", {
					params: { template_id: template.id },
					payload,
					// Abandoned parameter variants shouldn't accumulate.
					timeToLive: 60_000,
				})
			: idlePreviewAtom,
	)

	return Result.builder(result)
		.onSuccess((preview) => {
			const widgets = preview.widgets as unknown as DashboardWidget[]
			const shown = widgets.slice(0, MAX_PREVIEW_WIDGETS)
			const hidden = widgets.length - shown.length

			if (shown.length === 0) {
				return (
					<p className={cn("text-muted-foreground text-xs", className)}>
						This template starts you with an empty dashboard.
					</p>
				)
			}

			return (
				<div className={cn("flex flex-col gap-2", className)}>
					<DashboardTimeRangeWrapper initialTimeRange={preview.timeRange as TimeRange}>
						<PreviewGrid widgets={shown} />
					</DashboardTimeRangeWrapper>
					{hidden > 0 && (
						<p className="text-muted-foreground text-xs">
							{hidden} more {hidden === 1 ? "widget" : "widgets"} below the fold.
						</p>
					)}
				</div>
			)
		})
		.onError(() => (
			<div
				className={cn(
					"text-muted-foreground flex items-center gap-2 rounded-md border border-border border-dashed p-4 text-xs",
					className,
				)}
			>
				<CircleWarningIcon size={14} />
				Couldn't build the preview. You can still create the dashboard.
			</div>
		))
		.orElse(() => (
			<div className={className}>
				<PreviewSkeleton />
			</div>
		))
}
