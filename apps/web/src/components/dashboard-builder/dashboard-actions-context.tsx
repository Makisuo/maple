import * as React from "react"
import type { ReactNode } from "react"
import type { DashboardId } from "@maple/domain/http"
import { useNavigate } from "@tanstack/react-router"
import { toastManager } from "@maple/ui/components/ui/toast"
import { pickVariableParams } from "@/lib/dashboard-variables/search-params"

import type {
	DashboardWidget,
	VisualizationType,
	WidgetDataSource,
	WidgetDisplayConfig,
	WidgetMode,
} from "@/components/dashboard-builder/types"

interface DashboardActionsContextValue {
	dashboardId: DashboardId
	mode: WidgetMode
	readOnly: boolean
	removeWidget: (widgetId: string) => void
	cloneWidget: (widgetId: string) => void
	configureWidget: (widgetId: string) => void
	updateWidgetDisplay: (widgetId: string, display: Partial<WidgetDisplayConfig>) => void
	updateWidgetDataSource: (widgetId: string, dataSource: WidgetDataSource) => void
	updateWidgetLayouts: (layouts: Array<{ i: string; x: number; y: number; w: number; h: number }>) => void
	/**
	 * Returns the widget that was applied, or `undefined` when the add was
	 * refused — callers (the picker) use that to decide whether to close.
	 */
	addWidget: (
		visualization: VisualizationType,
		dataSource: WidgetDataSource,
		display: WidgetDisplayConfig,
	) => DashboardWidget | undefined
	autoLayoutWidgets: () => void
}

const DashboardActionsContext = React.createContext<DashboardActionsContextValue | null>(null)

interface DashboardActionsProviderProps {
	children: ReactNode
	dashboardId: DashboardId
	mode: WidgetMode
	readOnly: boolean
	store: {
		addWidget: (
			dashboardId: string,
			visualization: VisualizationType,
			dataSource: WidgetDataSource,
			display: WidgetDisplayConfig,
		) => DashboardWidget
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
				toastManager.add({
					title: "Widget removed",
					actionProps: {
						children: "Undo",
						onClick: () => store.restoreWidget(dashboardId, removed),
					},
					timeout: 6000,
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
					// Carry the dashboard's `var-*` selections into the editor so returning
					// from it restores them (the editor itself renders variables at defaults).
					search: (prev) => pickVariableParams(prev),
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
			// Never fails silently: a refused or failed add used to return here with
			// no trace, while the picker closed anyway — so the user saw a dialog
			// dismiss itself and no widget appear. The optimistic apply is
			// synchronous, so the returned widget is a true "it landed" signal; a
			// later persistence failure surfaces through the store's error banner.
			addWidget: (visualization, dataSource, display) => {
				if (readOnly) {
					toastManager.add({
						title: "Dashboard editing is unavailable right now",
						description: "Reconnect to the dashboard store, then add the widget again.",
						type: "error",
					})
					return undefined
				}

				let widget: DashboardWidget
				try {
					widget = store.addWidget(dashboardId, visualization, dataSource, display)
				} catch (cause) {
					toastManager.add({
						title: cause instanceof Error ? cause.message : "Couldn’t add the widget",
						type: "error",
					})
					return undefined
				}

				if (mode === "view") {
					navigate({
						to: "/dashboards/$dashboardId",
						params: { dashboardId },
						search: { mode: "edit" },
					})
				}
				return widget
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
