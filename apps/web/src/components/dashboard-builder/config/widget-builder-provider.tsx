import { type ReactNode, useMemo, createElement } from "react"
import {
	WidgetBuilderForm,
	WidgetBuilderInitialSnapshot,
	WidgetBuilderPreview,
} from "@/atoms/widget-query-builder-atoms"
import { AutocompleteValuesProvider } from "@/hooks/use-autocomplete-values"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { toInitialState } from "@/lib/query-builder/widget-builder-utils"
import type { QueryBuilderWidgetState } from "@/lib/query-builder/widget-builder-shared"
import type { DashboardWidget } from "@/components/dashboard-builder/types"

/**
 * The three builder atoms, scoped to one subtree.
 *
 * Split out from `WidgetBuilderProvider` so a caller that already holds builder
 * state can mount a scope without a `DashboardWidget` to derive it from, and
 * without the autocomplete provider. The widget lab does exactly that: one scope
 * per fixture cell, so each cell's settings rail edits its own state.
 */
export function WidgetBuilderScope({
	initialState,
	children,
}: {
	initialState: QueryBuilderWidgetState
	children?: ReactNode
}) {
	return createElement(
		WidgetBuilderForm.Provider,
		{ value: initialState as never },
		createElement(
			WidgetBuilderInitialSnapshot.Provider,
			{ value: initialState as never },
			createElement(WidgetBuilderPreview.Provider, { value: initialState as never }, children),
		),
	)
}

export function WidgetBuilderProvider({
	widget,
	children,
}: {
	widget: DashboardWidget
	children?: ReactNode
}) {
	const initialState = useMemo(() => toInitialState(widget), [widget])
	const {
		state: { resolvedTimeRange: resolvedTime },
	} = useDashboardTimeRange()

	return createElement(
		WidgetBuilderScope,
		{ initialState },
		createElement(AutocompleteValuesProvider, {
			startTime: resolvedTime?.startTime,
			endTime: resolvedTime?.endTime,
			lazy: true,
			children,
		}),
	)
}
