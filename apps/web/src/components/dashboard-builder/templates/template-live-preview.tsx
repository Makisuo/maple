import { memo, useDeferredValue, useMemo, useState } from "react"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/utils"
import type { V2DashboardTemplate } from "@maple/domain/http/v2"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { DashboardTimeRangeWrapper } from "@/components/dashboard-builder/dashboard-providers"
import { visualizationFor } from "@/components/dashboard-builder/widgets/visualization-registry"
import type { DashboardWidget, TimeRange } from "@/components/dashboard-builder/types"
import { useWidgetData } from "@/hooks/use-widget-data"
import { CircleWarningIcon } from "@/components/icons"

/** The 12-column grid every template lays its widgets out on. */
const GRID_COLUMNS = 12

/**
 * Pixels per layout row unit. Templates are authored for a full dashboard, so
 * the preview shrinks them — but not below the floor each visualization needs
 * to stay legible. Charts scaled purely by row unit lose their plot area and
 * render as a bare axis; stats clip their value. The floors below are what each
 * visualization needs to actually show something.
 */
const ROW_HEIGHT = 20

/** Minimum rendered height per visualization, in pixels. */
const MIN_HEIGHT: Record<string, number> = {
	stat: 84,
	gauge: 110,
	markdown: 64,
}
const MIN_HEIGHT_DEFAULT = 170

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
const PreviewWidget = memo(function PreviewWidget({ widget }: { widget: DashboardWidget }) {
	const { dataState } = useWidgetData(widget)
	const Visualization = visualizationFor(widget.visualization)

	return (
		<div
			className="min-w-0 overflow-hidden rounded-md border border-border bg-card"
			style={{
				gridColumn: `span ${Math.min(widget.layout.w, GRID_COLUMNS)}`,
				height: heightFor(widget),
			}}
		>
			<Visualization dataState={dataState} display={widget.display} mode="view" />
		</div>
	)
})

function PreviewSkeleton() {
	return (
		<div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, 1fr)` }}>
			<Skeleton className="col-span-4 h-[62px] rounded-md" />
			<Skeleton className="col-span-4 h-[62px] rounded-md" />
			<Skeleton className="col-span-4 h-[62px] rounded-md" />
			<Skeleton className="col-span-12 h-[84px] rounded-md" />
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
						<div
							className="grid gap-2"
							style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, 1fr)` }}
						>
							{shown.map((widget) => (
								<PreviewWidget key={widget.id} widget={widget} />
							))}
						</div>
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
