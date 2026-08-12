import { createContext, use, useMemo, type ReactNode } from "react"
import { useNavigate } from "@tanstack/react-router"

import type { SectionTarget } from "@maple/domain/http"
import { useDashboardActions } from "@/components/dashboard-builder/dashboard-actions-context"
import type { DashboardSection, DashboardWidget, WidgetDataState } from "@/components/dashboard-builder/types"
import {
	encodeWidgetFixContextToSearchParam,
	type WidgetFixContext,
} from "@/components/chat/widget-fix-context"
import { encodeAlertChartToSearchParam } from "@/lib/alerts/widget-chart-param"

export interface WidgetActions {
	remove?: () => void
	clone?: () => void
	configure?: () => void
	createAlert?: () => void
	fix?: () => void
	/**
	 * Pulls just this tile back to the widest window its query kind supports.
	 * Present only while the tile is blocked on a `range` error; local to the
	 * session, so it works on read-only dashboards too.
	 */
	narrowRange?: () => void
	/** Label for `narrowRange`, e.g. "Show last 7 days". */
	narrowRangeLabel?: string
	/**
	 * Re-home the widget into a group, or `null` for the root canvas. Present
	 * only in edit mode on a board that actually has groups — separate grids
	 * can't share a drag context, so this menu is how a tile changes group.
	 */
	moveToSection?: (target: SectionTarget) => void
	/** Destinations for `moveToSection`, in board order. */
	moveTargets?: DashboardSection[]
	/** Where the widget currently lives, so its own container reads as disabled. */
	moveCurrent?: SectionTarget
}

const WidgetActionsContext = createContext<WidgetActions | null>(null)

/**
 * Returns the widget actions provided by the nearest provider, or `null` when
 * rendered outside one (the template preview, which has no actions at all).
 */
export function useWidgetActions(): WidgetActions | null {
	return use(WidgetActionsContext)
}

/**
 * Supplies an explicit action set, for callers that render widgets outside a
 * dashboard — the widget lab, whose actions are console stubs. Widget renderers
 * take no action props; this is how you give them any.
 */
export function WidgetActionsScope({ actions, children }: { actions: WidgetActions; children: ReactNode }) {
	return <WidgetActionsContext value={actions}>{children}</WidgetActionsContext>
}

interface WidgetActionsProviderProps {
	widget: DashboardWidget
	dataState: WidgetDataState
	/** Supplied by `useWidgetData` when the tile is blocked on its range cap. */
	narrowRange?: () => void
	narrowRangeLabel?: string
	children: ReactNode
}

/**
 * Derives a single widget's action callbacks from the dashboard-level
 * `DashboardActionsContext` and exposes them via `WidgetActionsContext`. This
 * keeps the per-widget action wiring out of the canvas renderer and out of the
 * widget components' prop interfaces.
 */
export function WidgetActionsProvider({
	widget,
	dataState,
	narrowRange,
	narrowRangeLabel,
	children,
}: WidgetActionsProviderProps) {
	const {
		readOnly,
		removeWidget,
		cloneWidget,
		configureWidget,
		dashboardId,
		sections,
		moveWidgetToSection,
	} = useDashboardActions()
	const navigate = useNavigate()

	const errorTitle = dataState.status === "error" ? (dataState.title ?? null) : null
	const errorMessage = dataState.status === "error" ? (dataState.message ?? null) : null
	const errorKind = dataState.status === "error" ? dataState.kind : undefined

	const actions = useMemo<WidgetActions>(() => {
		const remove = () => removeWidget(widget.id)

		const clone = readOnly ? undefined : () => cloneWidget(widget.id)
		const configure = readOnly ? undefined : () => configureWidget(widget.id)

		// "Create alert" is offered for query-driven charts; the alert builder
		// warns when chart-only features need review.
		const endpoint = widget.dataSource?.endpoint
		const alertable =
			endpoint === "raw_sql_chart" ||
			endpoint === "custom_query_builder_timeseries" ||
			endpoint === "custom_query_builder_breakdown" ||
			endpoint === "custom_query_builder_list"
		const createAlert =
			dashboardId && alertable
				? () => {
						// Carry the live widget (optimistic builder state) so the alert
						// page prefills without racing the dashboard autosave; the
						// id pair stays as the lookup fallback for oversized payloads.
						const chart = encodeAlertChartToSearchParam({
							dashboardId,
							widget: {
								id: widget.id,
								visualization: widget.visualization,
								dataSource: {
									endpoint: widget.dataSource.endpoint,
									params: widget.dataSource.params,
									transform: widget.dataSource.transform,
								},
								display: { title: widget.display.title },
							},
						})
						navigate({
							to: "/alerts/create",
							search: {
								dashboardId,
								widgetId: widget.id,
								...(chart ? { chart } : {}),
							},
						})
					}
				: undefined

		const fix =
			dashboardId && errorKind === "decode"
				? () => {
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
				: undefined

		// Offered only when there is somewhere to move to: on a board with no
		// groups the submenu would list nothing but "Ungrouped", which is where
		// the widget already is.
		const canMove = !readOnly && sections.length > 0
		const moveToSection = canMove
			? (target: SectionTarget) => moveWidgetToSection(widget.id, target)
			: undefined

		return {
			remove,
			clone,
			configure,
			createAlert,
			fix,
			narrowRange,
			narrowRangeLabel,
			...(moveToSection
				? {
						moveToSection,
						moveTargets: sections,
						moveCurrent:
							widget.sectionId !== undefined && widget.tabId !== undefined
								? { sectionId: widget.sectionId, tabId: widget.tabId }
								: null,
					}
				: {}),
		}
	}, [
		widget,
		readOnly,
		removeWidget,
		cloneWidget,
		configureWidget,
		sections,
		moveWidgetToSection,
		dashboardId,
		errorKind,
		errorTitle,
		errorMessage,
		navigate,
		narrowRange,
		narrowRangeLabel,
	])

	return <WidgetActionsContext value={actions}>{children}</WidgetActionsContext>
}
