import * as React from "react"
import type { ReactNode } from "react"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"

import type {
	DashboardWidget,
	VisualizationType,
	WidgetDataSource,
	WidgetDisplayConfig,
	WidgetMode,
} from "@/components/dashboard-builder/types"

interface DashboardActionsContextValue {
	dashboardId: string
	mode: WidgetMode
	readOnly: boolean
	removeWidget: (widgetId: string) => void
	cloneWidget: (widgetId: string) => void
	configureWidget: (widgetId: string) => void
	updateWidgetDisplay: (widgetId: string, display: Partial<WidgetDisplayConfig>) => void
	updateWidgetDataSource: (widgetId: string, dataSource: WidgetDataSource) => void
	updateWidgetLayouts: (layouts: Array<{ i: string; x: number; y: number; w: number; h: number }>) => void
	addWidget: (
		visualization: VisualizationType,
		dataSource: WidgetDataSource,
		display: WidgetDisplayConfig,
	) => void
	autoLayoutWidgets: () => void
}

const DashboardActionsContext = React.createContext<DashboardActionsContextValue | null>(null)

interface DashboardActionsProviderProps {
	children: ReactNode
	dashboardId: string
	mode: WidgetMode
	readOnly: boolean
	store: {
		addWidget: (
			dashboardId: string,
			visualization: VisualizationType,
			dataSource: WidgetDataSource,
			display: WidgetDisplayConfig,
		) => void
		removeWidget: (dashboardId: string, widgetId: string) => DashboardWidget | undefined
		restoreWidget: (dashboardId: string, widget: DashboardWidget) => void
		cloneWidget: (dashboardId: string, widgetId: string) => void
		updateWidgetDisplay: (
			dashboardId: string,
			widgetId: string,
			display: Partial<WidgetDisplayConfig>,
		) => void
		updateWidget: (
			dashboardId: string,
			widgetId: string,
			updates: Partial<Pick<DashboardWidget, "visualization" | "dataSource" | "display" | "layout">>,
		) => unknown
		updateWidgetLayouts: (
			dashboardId: string,
			layouts: Array<{
				i: string
				x: number
				y: number
				w: number
				h: number
			}>,
		) => void
		autoLayoutWidgets: (dashboardId: string) => void
	}
}

export function DashboardActionsProvider({
	children,
	dashboardId,
	mode,
	readOnly,
	store,
}: DashboardActionsProviderProps) {
	const navigate = useNavigate()

	const ctx = React.useMemo<DashboardActionsContextValue>(
		() => ({
			dashboardId,
			mode,
			readOnly,
			removeWidget: (widgetId) => {
				if (readOnly) return
				const removed = store.removeWidget(dashboardId, widgetId)
				if (!removed) return
				toast("Widget removed", {
					action: {
						label: "Undo",
						onClick: () => store.restoreWidget(dashboardId, removed),
					},
					duration: 6000,
				})
			},
			cloneWidget: (widgetId) => {
				if (readOnly) return
				store.cloneWidget(dashboardId, widgetId)
			},
			configureWidget: (widgetId) => {
				if (readOnly) return
				navigate({
					to: "/dashboards/$dashboardId/widgets/$widgetId",
					params: { dashboardId, widgetId },
				})
			},
			updateWidgetDisplay: (widgetId, display) => {
				if (readOnly) return
				store.updateWidgetDisplay(dashboardId, widgetId, display)
			},
			updateWidgetDataSource: (widgetId, dataSource) => {
				if (readOnly) return
				store.updateWidget(dashboardId, widgetId, { dataSource })
			},
			updateWidgetLayouts: (layouts) => {
				if (readOnly) return
				store.updateWidgetLayouts(dashboardId, layouts)
			},
			addWidget: (visualization, dataSource, display) => {
				if (readOnly) return
				store.addWidget(dashboardId, visualization, dataSource, display)
				if (mode === "view") {
					navigate({
						to: "/dashboards/$dashboardId",
						params: { dashboardId },
						search: { mode: "edit" },
					})
				}
			},
			autoLayoutWidgets: () => {
				if (readOnly) return
				store.autoLayoutWidgets(dashboardId)
			},
		}),
		[dashboardId, mode, readOnly, store, navigate],
	)

	return <DashboardActionsContext value={ctx}>{children}</DashboardActionsContext>
}

export function useDashboardActions(): DashboardActionsContextValue {
	const ctx = React.use(DashboardActionsContext)
	if (!ctx) throw new Error("useDashboardActions must be used within DashboardActionsProvider")
	return ctx
}
