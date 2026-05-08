import { memo, useCallback, useMemo, useRef } from "react"
import { useNavigate } from "@tanstack/react-router"
import { GridLayout, useContainerWidth, verticalCompactor } from "react-grid-layout"
import type { Layout } from "react-grid-layout"
import "react-grid-layout/css/styles.css"

import type {
	WidgetDataState,
	DashboardWidget,
	WidgetDisplayConfig,
	WidgetMode,
} from "@/components/dashboard-builder/types"
import { useDashboardActions } from "@/components/dashboard-builder/dashboard-actions-context"
import { useWidgetData } from "@/hooks/use-widget-data"
import {
	encodeWidgetFixContextToSearchParam,
	type WidgetFixContext,
} from "@/components/chat/widget-fix-context"
import { ChartWidget } from "@/components/dashboard-builder/widgets/chart-widget"
import { StatWidget } from "@/components/dashboard-builder/widgets/stat-widget"
import { TableWidget } from "@/components/dashboard-builder/widgets/table-widget"
import { ListWidget } from "@/components/dashboard-builder/widgets/list-widget"
import { PieWidget } from "@/components/dashboard-builder/widgets/pie-widget"
import { HistogramWidget } from "@/components/dashboard-builder/widgets/histogram-widget"
import { HeatmapWidget } from "@/components/dashboard-builder/widgets/heatmap-widget"
import { MarkdownWidget } from "@/components/dashboard-builder/widgets/markdown-widget"

interface DashboardCanvasProps {
	widgets: DashboardWidget[]
	/**
	 * When true, the grid is read-only: drag/resize disabled, layout-change
	 * callbacks suppressed. Used while previewing a historical version so
	 * interactions don't accidentally mutate the live dashboard.
	 */
	readOnly?: boolean
}

const visualizationRegistry: Record<
	string,
	React.ComponentType<{
		dataState: WidgetDataState
		display: WidgetDisplayConfig
		mode: WidgetMode
		onRemove: () => void
		onClone?: () => void
		onConfigure?: () => void
		onFix?: () => void
	}>
> = {
	chart: ChartWidget,
	stat: StatWidget,
	table: TableWidget,
	list: ListWidget,
	pie: PieWidget,
	histogram: HistogramWidget,
	heatmap: HeatmapWidget,
	markdown: MarkdownWidget,
}

const WidgetRenderer = memo(function WidgetRenderer({ widget }: { widget: DashboardWidget }) {
	const { mode, readOnly, removeWidget, cloneWidget, configureWidget, dashboardId } =
		useDashboardActions()
	const { dataState } = useWidgetData(widget)
	const Visualization = visualizationRegistry[widget.visualization] ?? visualizationRegistry.chart
	const navigate = useNavigate()

	const onRemove = useCallback(() => removeWidget(widget.id), [removeWidget, widget.id])

	const onClone = useMemo(
		() => (readOnly ? undefined : () => cloneWidget(widget.id)),
		[readOnly, cloneWidget, widget.id],
	)

	const onConfigure = useMemo(
		() => (readOnly ? undefined : () => configureWidget(widget.id)),
		[readOnly, configureWidget, widget.id],
	)

	const errorTitle = dataState.status === "error" ? (dataState.title ?? null) : null
	const errorMessage = dataState.status === "error" ? (dataState.message ?? null) : null
	const errorKind = dataState.status === "error" ? dataState.kind : undefined
	const onFix = useMemo(() => {
		if (!dashboardId) return undefined
		if (errorKind !== "decode") return undefined
		return () => {
			const ctx: WidgetFixContext = {
				dashboardId,
				widgetId: widget.id,
				widgetTitle: widget.display.title ?? "Untitled",
				widgetJson: JSON.stringify(widget),
				errorTitle,
				errorMessage,
			}
			navigate({
				to: "/chat",
				search: {
					mode: "widget-fix",
					widget: encodeWidgetFixContextToSearchParam(ctx),
				},
			})
		}
	}, [dashboardId, errorKind, errorTitle, errorMessage, widget, navigate])

	return (
		<Visualization
			dataState={dataState}
			display={widget.display}
			mode={mode}
			onRemove={onRemove}
			onClone={onClone}
			onConfigure={onConfigure}
			onFix={onFix}
		/>
	)
})

export function DashboardCanvas({ widgets, readOnly = false }: DashboardCanvasProps) {
	const { mode, updateWidgetLayouts } = useDashboardActions()
	const { width, containerRef, mounted } = useContainerWidth()
	const editable = mode === "edit" && !readOnly

	const layouts: Layout = useMemo(
		() =>
			widgets.map((w) => ({
				i: w.id,
				x: w.layout.x,
				y: w.layout.y,
				w: w.layout.w,
				h: w.layout.h,
				minW: w.layout.minW ?? 2,
				minH: w.layout.minH ?? 2,
				...(w.layout.maxW != null ? { maxW: w.layout.maxW } : {}),
				...(w.layout.maxH != null ? { maxH: w.layout.maxH } : {}),
			})),
		[widgets],
	)

	// react-grid-layout fires onLayoutChange once on mount with the
	// post-compaction layout. That first call is not a real user edit, so
	// we drop it to avoid a spurious upsert that invalidates the dashboards
	// list and cascades a re-render of every widget.
	const initialLayoutSeenRef = useRef(false)

	const handleLayoutChange = useCallback(
		(layout: Layout) => {
			if (readOnly) return
			if (!initialLayoutSeenRef.current) {
				initialLayoutSeenRef.current = true
				return
			}
			updateWidgetLayouts(
				layout.map((l) => ({
					i: l.i,
					x: l.x,
					y: l.y,
					w: l.w,
					h: l.h,
				})),
			)
		},
		[readOnly, updateWidgetLayouts],
	)

	return (
		<div ref={containerRef}>
			{mounted && (
				<GridLayout
					width={width}
					layout={layouts}
					gridConfig={{
						cols: 12,
						rowHeight: 60,
						margin: [12, 12] as [number, number],
					}}
					dragConfig={{
						enabled: editable,
						handle: ".widget-drag-handle",
						bounded: false,
						threshold: 3,
					}}
					resizeConfig={{
						enabled: editable,
						handles: ["se"],
					}}
					compactor={verticalCompactor}
					onLayoutChange={handleLayoutChange}
				>
					{widgets.map((widget) => (
						<div key={widget.id}>
							<WidgetRenderer widget={widget} />
						</div>
					))}
				</GridLayout>
			)}
		</div>
	)
}
