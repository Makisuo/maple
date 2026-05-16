import * as React from "react"
import type { ReactNode } from "react"
import { useNavigate } from "@tanstack/react-router"

import { useDashboardActions } from "@/components/dashboard-builder/dashboard-actions-context"
import type { DashboardWidget, WidgetDataState } from "@/components/dashboard-builder/types"
import {
	encodeWidgetFixContextToSearchParam,
	type WidgetFixContext,
} from "@/components/chat/widget-fix-context"

export interface WidgetActions {
	remove?: () => void
	clone?: () => void
	configure?: () => void
	createAlert?: () => void
	fix?: () => void
}

const WidgetActionsContext = React.createContext<WidgetActions | null>(null)

/**
 * Returns the widget actions provided by the nearest `WidgetActionsProvider`,
 * or `null` when rendered outside one (e.g. the widget lab, which passes
 * explicit action props instead).
 */
export function useWidgetActions(): WidgetActions | null {
	return React.use(WidgetActionsContext)
}

interface WidgetActionsProviderProps {
	widget: DashboardWidget
	dataState: WidgetDataState
	children: ReactNode
}

/**
 * Derives a single widget's action callbacks from the dashboard-level
 * `DashboardActionsContext` and exposes them via `WidgetActionsContext`. This
 * keeps the per-widget action wiring out of the canvas renderer and out of the
 * widget components' prop interfaces.
 */
export function WidgetActionsProvider({ widget, dataState, children }: WidgetActionsProviderProps) {
	const { readOnly, removeWidget, cloneWidget, configureWidget, dashboardId } =
		useDashboardActions()
	const navigate = useNavigate()

	const errorTitle = dataState.status === "error" ? (dataState.title ?? null) : null
	const errorMessage = dataState.status === "error" ? (dataState.message ?? null) : null
	const errorKind = dataState.status === "error" ? dataState.kind : undefined

	const actions = React.useMemo<WidgetActions>(() => {
		const remove = () => removeWidget(widget.id)

		const clone = readOnly ? undefined : () => cloneWidget(widget.id)
		const configure = readOnly ? undefined : () => configureWidget(widget.id)

		// "Create alert" is offered for query-driven charts (query builder + raw
		// SQL) — those data sources convert cleanly to an alert rule.
		const endpoint = widget.dataSource?.endpoint
		const alertable =
			endpoint === "raw_sql_chart" ||
			endpoint === "custom_query_builder_timeseries" ||
			endpoint === "custom_query_builder_breakdown" ||
			endpoint === "custom_query_builder_list"
		const createAlert =
			dashboardId && alertable
				? () => navigate({ to: "/alerts/create", search: { dashboardId, widgetId: widget.id } })
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

		return { remove, clone, configure, createAlert, fix }
	}, [
		widget,
		readOnly,
		removeWidget,
		cloneWidget,
		configureWidget,
		dashboardId,
		errorKind,
		errorTitle,
		errorMessage,
		navigate,
	])

	return <WidgetActionsContext value={actions}>{children}</WidgetActionsContext>
}
