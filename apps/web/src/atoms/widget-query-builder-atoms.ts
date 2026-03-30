import { Atom, ScopedAtom } from "@/lib/effect-atom"
import type { QueryBuilderWidgetState } from "@/components/dashboard-builder/config/widget-query-builder-page"

export const WidgetBuilderForm = ScopedAtom.make(
  (initial: QueryBuilderWidgetState) => Atom.make(initial),
)

export const WidgetBuilderInitialSnapshot = ScopedAtom.make(
  (initial: QueryBuilderWidgetState) => Atom.make(initial),
)

export const WidgetBuilderPreview = ScopedAtom.make(
  (initial: QueryBuilderWidgetState) => Atom.make(initial),
)
