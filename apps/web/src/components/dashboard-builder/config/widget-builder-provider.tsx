import { type ReactNode, useMemo, createElement } from "react"
import {
  WidgetBuilderForm,
  WidgetBuilderInitialSnapshot,
  WidgetBuilderPreview,
} from "@/atoms/widget-query-builder-atoms"
import { AutocompleteKeysProvider } from "@/hooks/use-autocomplete-context"
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

  return createElement(
    WidgetBuilderForm.Provider,
    { value: initialState as never },
    createElement(
      WidgetBuilderInitialSnapshot.Provider,
      { value: initialState as never },
      createElement(
        WidgetBuilderPreview.Provider,
        { value: initialState as never },
        createElement(AutocompleteKeysProvider, null, children),
      ),
    ),
  )
}
