/**
 * The authed dashboard's widget renderer: live data, and the full action set.
 *
 * Deliberately not in `dashboard-canvas.tsx`. The grid itself is now mounted by
 * read-only surfaces too — a share link, a full-screen board — which fetch
 * through a different path and must expose no actions at all. Keeping
 * `useWidgetData`, `useDashboardActions` and `WidgetActionsProvider` out of the
 * grid module is what makes that reuse honest rather than conditional: the grid
 * takes a renderer, and each mount point names the one it means.
 */
import { memo, useEffect, useRef, useState } from "react"
import { dataSourceTransform } from "@maple/widgets/dashboard"

import type { DashboardWidget } from "@/components/dashboard-builder/types"
import { useDashboardActions } from "@/components/dashboard-builder/dashboard-actions-context"
import { WidgetActionsProvider } from "@/components/dashboard-builder/widgets/widget-actions-context"
import { WidgetTimeRangeProvider } from "@/components/dashboard-builder/widgets/widget-time-range-context"
import { visualizationFor } from "@/components/dashboard-builder/widgets/types"
import { useWidgetData } from "@/hooks/use-widget-data"
import { useWidgetMaxDataPoints } from "@/hooks/use-widget-max-data-points"
import { toPanelType } from "@/lib/query-builder/panel-types"

/**
 * Latches `true` the first time the element scrolls into (near) the viewport,
 * then stays latched. Tiles fetch their data lazily on first reveal and keep it
 * — unlatching would unmount the tile's atom, and a non-sticky flag would then
 * refetch every time it scrolled back into view. The 200ms debounce absorbs
 * react-grid-layout's mount-time reflow, where tiles can briefly flash into
 * view before the layout settles.
 */
function useInViewportSticky() {
	const ref = useRef<HTMLDivElement>(null)
	const [visible, setVisible] = useState(false)

	useEffect(() => {
		if (visible) return
		const element = ref.current
		if (!element) return
		if (typeof IntersectionObserver === "undefined") {
			setVisible(true)
			return
		}

		let timer: ReturnType<typeof setTimeout> | undefined
		const observer = new IntersectionObserver(
			(entries) => {
				const isIntersecting = entries.some((entry) => entry.isIntersecting)
				if (isIntersecting && timer == null) {
					timer = setTimeout(() => setVisible(true), 200)
				} else if (!isIntersecting && timer != null) {
					clearTimeout(timer)
					timer = undefined
				}
			},
			{ rootMargin: "200px" },
		)
		observer.observe(element)
		return () => {
			if (timer != null) clearTimeout(timer)
			observer.disconnect()
		}
	}, [visible])

	return { ref, visible }
}

export const LiveWidgetRenderer = memo(function LiveWidgetRenderer({ widget }: { widget: DashboardWidget }) {
	const { mode } = useDashboardActions()
	const { ref, visible } = useInViewportSticky()
	// The tile's width decides its auto bucket (one point per pixel, Grafana's
	// `$__interval`), so the same widget is coarser at a third of the row than at
	// full width — measured on the same element the viewport latch observes.
	const maxDataPoints = useWidgetMaxDataPoints(
		ref,
		toPanelType(widget.visualization, widget.display.chartId),
	)
	const { dataState, narrowRange, narrowRangeLabel } = useWidgetData(widget, visible, { maxDataPoints })
	const Visualization = visualizationFor(widget.visualization)

	return (
		<div ref={ref} className="h-full w-full">
			<WidgetTimeRangeProvider timeRange={widget.timeRange}>
				<WidgetActionsProvider
					widget={widget}
					dataState={dataState}
					narrowRange={narrowRange}
					narrowRangeLabel={narrowRangeLabel}
				>
					<Visualization
						dataState={dataState}
						display={widget.display}
						mode={mode}
						rowLimit={dataSourceTransform(widget.dataSource)?.limit}
					/>
				</WidgetActionsProvider>
			</WidgetTimeRangeProvider>
		</div>
	)
})
