import { type ReactNode, useMemo, createElement } from "react"
import {
  WidgetBuilderForm,
  WidgetBuilderInitialSnapshot,
  WidgetBuilderPreview,
} from "@/atoms/widget-query-builder-atoms"
import { AutocompleteValuesProvider } from "@/hooks/use-autocomplete-values"
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { toInitialState } from "@/lib/query-builder/widget-builder-utils"
import type { DashboardWidget } from "@/components/dashboard-builder/types"

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
    WidgetBuilderForm.Provider,
    { value: initialState as never },
    createElement(
      WidgetBuilderInitialSnapshot.Provider,
      { value: initialState as never },
      createElement(
        WidgetBuilderPreview.Provider,
        { value: initialState as never },
        createElement(AutocompleteValuesProvider, {
          startTime: resolvedTime?.startTime,
          endTime: resolvedTime?.endTime,
          lazy: true,
          children,
        }),
      ),
    ),
  )
}
