import { Atom, ScopedAtom } from "@/lib/effect-atom"
import type { QueryBuilderWidgetState } from "@/lib/query-builder/widget-builder-utils"

export const WidgetBuilderForm = ScopedAtom.make((initial: QueryBuilderWidgetState) => Atom.make(initial))

export const WidgetBuilderInitialSnapshot = ScopedAtom.make((initial: QueryBuilderWidgetState) =>
	Atom.make(initial),
)

export const WidgetBuilderPreview = ScopedAtom.make((initial: QueryBuilderWidgetState) => Atom.make(initial))
