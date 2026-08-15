// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import * as React from "react"
import type { ReactNode } from "react"
import type { DashboardId } from "@maple/domain/http"
import { useNavigate } from "@tanstack/react-router"
import { toastManager } from "@maple/ui/components/ui/toast"
import { pickDashboardControlParams } from "@/lib/dashboard-controls/search-params"

import type { SectionTarget } from "@maple/domain/http"
import type {
	DashboardSection,
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
	/** The board's groups, so a widget's kebab can offer "Move to…" destinations. */
	sections: DashboardSection[]
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
		target?: SectionTarget,
	) => DashboardWidget | undefined
	autoLayoutWidgets: () => void
	/** Returns the new section's id so the caller can focus its rename input. */
	addSection: (title?: string) => string | undefined
	renameSection: (sectionId: string, title: string) => void
	setSectionCollapsedDefault: (sectionId: string, collapsed: boolean) => void
	/** `false` pins the group open: no chevron, and `?collapsed=` naming it is ignored. */
	setSectionCollapsible: (sectionId: string, collapsible: boolean) => void
	reorderSections: (fromIndex: number, toIndex: number) => void
	deleteSection: (sectionId: string, action: "ungroup" | "delete") => void
	addTab: (sectionId: string) => string | undefined
	renameTab: (sectionId: string, tabId: string, title: string) => void
	deleteTab: (sectionId: string, tabId: string, action: "move" | "delete") => void
	moveWidgetToSection: (widgetId: string, target: SectionTarget) => void
}

const DashboardActionsContext = React.createContext<DashboardActionsContextValue | null>(null)

interface DashboardActionsProviderProps {
	children: ReactNode
	dashboardId: DashboardId
	mode: WidgetMode
	readOnly: boolean
	sections: DashboardSection[]
	store: {
		addWidget: (
			dashboardId: string,
			visualization: VisualizationType,
			dataSource: WidgetDataSource,
			display: WidgetDisplayConfig,
			target?: SectionTarget,
		) => DashboardWidget
		addSection: (dashboardId: string, title?: string) => string | undefined
		renameSection: (dashboardId: string, sectionId: string, title: string) => void
		setSectionCollapsedDefault: (dashboardId: string, sectionId: string, collapsed: boolean) => void
		setSectionCollapsible: (dashboardId: string, sectionId: string, collapsible: boolean) => void
		reorderSections: (dashboardId: string, fromIndex: number, toIndex: number) => void
		deleteSection: (
			dashboardId: string,
			sectionId: string,
			action: "ungroup" | "delete",
		) => DashboardWidget[] | undefined
		addTab: (dashboardId: string, sectionId: string, title?: string) => string | undefined
		renameTab: (dashboardId: string, sectionId: string, tabId: string, title: string) => void
		deleteTab: (dashboardId: string, sectionId: string, tabId: string, action: "move" | "delete") => void
		moveWidgetToSection: (dashboardId: string, widgetId: string, target: SectionTarget) => void
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
	sections,
	store,
}: DashboardActionsProviderProps) {
	const navigate = useNavigate()

	const ctx = React.useMemo<DashboardActionsContextValue>(
		() => ({
			dashboardId,
			mode,
			readOnly,
			sections,
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
					// Carry the dashboard's per-viewer controls into the editor so returning
					// from it restores them (the editor itself renders variables at defaults).
					search: (prev) => pickDashboardControlParams(prev),
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
			addWidget: (visualization, dataSource, display, target = null) => {
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
					widget = store.addWidget(dashboardId, visualization, dataSource, display, target)
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
						// Functional, not a bare `{ mode: "edit" }`: adding a widget from
						// view mode used to drop every `var-*` selection and view param on
						// the way into edit mode.
						search: (prev) => ({
							...pickDashboardControlParams(prev),
							mode: "edit" as const,
						}),
					})
				}
				return widget
			},
			autoLayoutWidgets: () => {
				if (readOnly) return
				store.autoLayoutWidgets(dashboardId)
			},
			addSection: (title) => (readOnly ? undefined : store.addSection(dashboardId, title)),
			renameSection: (sectionId, title) => {
				if (readOnly) return
				store.renameSection(dashboardId, sectionId, title)
			},
			setSectionCollapsedDefault: (sectionId, collapsed) => {
				if (readOnly) return
				store.setSectionCollapsedDefault(dashboardId, sectionId, collapsed)
			},
			setSectionCollapsible: (sectionId, collapsible) => {
				if (readOnly) return
				store.setSectionCollapsible(dashboardId, sectionId, collapsible)
			},
			reorderSections: (fromIndex, toIndex) => {
				if (readOnly) return
				store.reorderSections(dashboardId, fromIndex, toIndex)
			},
			// Undo restores the widgets but not the group itself: re-creating a
			// section would mint a new id, so the widgets could not be re-addressed
			// to it. Deliberately offers the smaller, honest promise.
			deleteSection: (sectionId, action) => {
				if (readOnly) return
				const removed = store.deleteSection(dashboardId, sectionId, action)
				if (!removed || removed.length === 0) return
				toastManager.add({
					title: `Group and ${removed.length === 1 ? "its widget" : `${removed.length} widgets`} deleted`,
					actionProps: {
						children: "Undo",
						onClick: () => {
							for (const widget of removed) store.restoreWidget(dashboardId, widget)
						},
					},
					timeout: 6000,
				})
			},
			addTab: (sectionId) => (readOnly ? undefined : store.addTab(dashboardId, sectionId)),
			renameTab: (sectionId, tabId, title) => {
				if (readOnly) return
				store.renameTab(dashboardId, sectionId, tabId, title)
			},
			deleteTab: (sectionId, tabId, action) => {
				if (readOnly) return
				store.deleteTab(dashboardId, sectionId, tabId, action)
			},
			moveWidgetToSection: (widgetId, target) => {
				if (readOnly) return
				store.moveWidgetToSection(dashboardId, widgetId, target)
			},
		}),
		[dashboardId, mode, readOnly, sections, store, navigate],
	)

	return <DashboardActionsContext value={ctx}>{children}</DashboardActionsContext>
}

/**
 * The dashboard's actions, or `null` when rendered outside a provider.
 *
 * The read-only surfaces — a share link, a full-screen board — mount the same
 * canvas with no store behind it, and every mutation here needs one. `null`
 * says exactly that: on this surface no action exists.
 *
 * Deliberately not a no-op stub provider. A non-null context makes
 * `WidgetActionsProvider` viable downstream, and that provider always defines
 * `remove` and offers `createAlert`, which `WidgetShell` shows in view mode —
 * so a stub would put edit affordances and authed-route navigation on a public
 * page. Absence is the only honest empty action set.
 */
export function useDashboardActionsOptional(): DashboardActionsContextValue | null {
	return React.use(DashboardActionsContext)
}

export function useDashboardActions(): DashboardActionsContextValue {
	const ctx = useDashboardActionsOptional()
	if (!ctx) throw new Error("useDashboardActions must be used within DashboardActionsProvider")
	return ctx
}
