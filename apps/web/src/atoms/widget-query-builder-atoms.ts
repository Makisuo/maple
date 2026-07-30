import { Atom, ScopedAtom } from "@/lib/effect-atom"
// Imported from the shared module rather than `widget-builder-utils` so these
// atoms don't pull the widget-type registry (and every renderer with it) into
// whatever imports them.
import type { QueryBuilderWidgetState } from "@/lib/query-builder/widget-builder-shared"

export const WidgetBuilderForm = ScopedAtom.make((initial: QueryBuilderWidgetState) => Atom.make(initial))

export const WidgetBuilderInitialSnapshot = ScopedAtom.make((initial: QueryBuilderWidgetState) =>
	Atom.make(initial),
)

export const WidgetBuilderPreview = ScopedAtom.make((initial: QueryBuilderWidgetState) => Atom.make(initial))
