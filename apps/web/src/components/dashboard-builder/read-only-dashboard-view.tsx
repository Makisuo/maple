/**
 * A dashboard with nothing to act on: the board, its groups, and its tiles at
 * the sizes they were authored at.
 *
 * One component, two mount points — a share link (redacted widgets, data from
 * the public share API) and the full-screen view of a live board. They render
 * through the same canvas as the editable dashboard, so a tile can never end up
 * a different size here than it is there; the only thing that varies is which
 * renderer draws a widget, which is the `renderWidget` prop.
 *
 * Read-only is enforced twice over and deliberately so: `readOnly` is passed
 * down, and outside a `DashboardActionsProvider` `mode` falls back to `"view"`.
 * Either alone makes `editable` false — no drag handles, no resize, no layout
 * writes, and no "widen the window to rearrange" hint.
 */
import { useState, type ReactNode } from "react"
import type { DashboardSection } from "@maple/widgets/dashboard"

import type {
	CanvasWidget,
	WidgetRendererComponent,
} from "@/components/dashboard-builder/canvas/dashboard-canvas"
import { DashboardSections } from "@/components/dashboard-builder/sections/dashboard-sections"
import {
	withActiveTab,
	withSectionCollapsed,
	type SectionViewSearch,
} from "@/lib/dashboards/section-view-state"

interface ReadOnlyDashboardViewProps<W extends CanvasWidget> {
	widgets: ReadonlyArray<W>
	sections: ReadonlyArray<DashboardSection>
	renderWidget: WidgetRendererComponent<W>
	/** Rendered above the board, when the surface wants a heading of its own. */
	header?: ReactNode
}

export function ReadOnlyDashboardView<W extends CanvasWidget>({
	widgets,
	sections,
	renderWidget,
	header,
}: ReadOnlyDashboardViewProps<W>) {
	// Local, not URL-backed. Which group a reader has open is throwaway state,
	// and on a share every search param becomes part of a public link's
	// contract — the same call `PreviewedCanvas` makes, for the same reason.
	const [viewSearch, setViewSearch] = useState<SectionViewSearch>({})

	return (
		<div className="flex h-full min-h-0 w-full flex-col">
			{header}
			<div className="min-h-0 flex-1 overflow-y-auto">
				<DashboardSections
					widgets={widgets}
					sections={sections}
					search={viewSearch}
					onToggleCollapsed={(sectionId, collapsed) =>
						setViewSearch((prev) => withSectionCollapsed(prev, sectionId, collapsed))
					}
					onSelectTab={(sectionId, tabId) =>
						setViewSearch((prev) => withActiveTab(prev, sectionId, tabId))
					}
					// Nothing to add to: the "+" is gated on `editable`, which is false
					// here, so this never fires.
					onAddWidget={() => undefined}
					readOnly
					renderWidget={renderWidget}
				/>
			</div>
		</div>
	)
}
