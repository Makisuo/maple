import { useMemo, useRef } from "react"
import { useContainerSize } from "@maple/ui/hooks/use-container-size"
import { cn } from "@maple/ui/lib/utils"
import { containerKeyFor, containerKeyOf, ROOT_CONTAINER_KEY } from "@maple/domain/http"

import { DashboardGrid } from "@/components/dashboard-builder/canvas/dashboard-canvas"
import { tierForWidth } from "@/components/dashboard-builder/canvas/grid-breakpoints"
import { DashboardSectionView } from "@/components/dashboard-builder/sections/dashboard-section"
import { useDashboardActions } from "@/components/dashboard-builder/dashboard-actions-context"
import type { DashboardSection, DashboardWidget } from "@/components/dashboard-builder/types"
import { resolveSectionView, type SectionViewSearch } from "@/lib/dashboards/section-view-state"

interface DashboardSectionsProps {
	widgets: DashboardWidget[]
	sections: DashboardSection[]
	/** Per-viewer view state from the URL. */
	search: SectionViewSearch
	onToggleCollapsed: (sectionId: string, collapsed: boolean) => void
	onSelectTab: (sectionId: string, tabId: string) => void
	onAddWidget: (sectionId: string, tabId: string) => void
	readOnly?: boolean
}

/**
 * The sectioned board: a root grid of ungrouped widgets, then each group in
 * order.
 *
 * Owns the *single* width measurement for the whole page. Measuring per section
 * would let two groups disagree about which breakpoint they are on — one
 * rearrangeable, its neighbour locked — and would spin up a `ResizeObserver` per
 * group. One measurement, one `tier`, every grid agrees.
 */
export function DashboardSections({
	widgets,
	sections,
	search,
	onToggleCollapsed,
	onSelectTab,
	onAddWidget,
	readOnly = false,
}: DashboardSectionsProps) {
	const { mode } = useDashboardActions()

	const containerRef = useRef<HTMLDivElement>(null)
	const { width: measuredWidth } = useContainerSize(containerRef)
	// Rounded so subpixel container widths don't re-lay-out every grid.
	const width = Math.round(measuredWidth)
	const measured = width > 0

	// Only the canonical tier's layout is authored and persisted; narrower ones
	// are projected from it at render time. Editing there would write a
	// phone-shaped layout over the real one, so drag, resize and persistence stay
	// gated on `tier.canonical` exactly as on the flat canvas.
	const tier = tierForWidth(width)
	const editable = mode === "edit" && !readOnly && tier.canonical

	// Bucket once per (widgets, sections) identity and hand each grid a
	// referentially stable subset, so dragging inside one group doesn't
	// re-render its siblings.
	const byContainer = useMemo(() => {
		const buckets = new Map<string, DashboardWidget[]>()
		buckets.set(ROOT_CONTAINER_KEY, [])
		for (const section of sections) {
			for (const tab of section.tabs) {
				buckets.set(containerKeyFor({ sectionId: section.id, tabId: tab.id }), [])
			}
		}
		for (const widget of widgets) {
			const bucket = buckets.get(containerKeyOf(widget)) ?? buckets.get(ROOT_CONTAINER_KEY)
			bucket?.push(widget)
		}
		return buckets
	}, [widgets, sections])

	// Resolved as a derivation, not an effect: a `?widget=` deep link has to
	// force its section open *before* first paint, or the target tile mounts
	// collapsed, unmounts, and remounts — firing its query twice.
	const view = useMemo(
		() => resolveSectionView(sections, widgets, search),
		[sections, widgets, search],
	)

	const rootWidgets = byContainer.get(ROOT_CONTAINER_KEY) ?? []

	return (
		// `is-layout-locked` lets WidgetShell hide its drag grip when the grid is
		// showing a generated layout — a grip that can't be dragged reads as a bug.
		// On the wrapper, not per section, so every group locks together.
		<div ref={containerRef} className={cn("group/canvas", !tier.canonical && "is-layout-locked")}>
			{mode === "edit" && !readOnly && !tier.canonical && (
				<p className="mb-3 text-xs text-muted-foreground">
					Showing a layout adapted to this width. Widen the window to rearrange widgets.
				</p>
			)}

			{measured && (
				<>
					{rootWidgets.length > 0 && (
						<DashboardGrid
							widgets={rootWidgets}
							width={width}
							tier={tier}
							editable={editable}
						/>
					)}

					{sections.map((section, index) => {
						const activeTabId = view.activeTabs.get(section.id) ?? section.tabs[0]?.id ?? section.id
						const tabWidgets =
							byContainer.get(containerKeyFor({ sectionId: section.id, tabId: activeTabId })) ?? []
						return (
							<DashboardSectionView
								key={section.id}
								section={section}
								widgets={tabWidgets}
								sectionWidgetCount={
									widgets.filter((widget) => widget.sectionId === section.id).length
								}
								widgetCountInTab={(tabId) =>
									(byContainer.get(containerKeyFor({ sectionId: section.id, tabId })) ?? []).length
								}
								activeTabId={activeTabId}
								collapsed={view.collapsed.has(section.id)}
								index={index}
								sectionCount={sections.length}
								width={width}
								tier={tier}
								editable={editable}
								onToggleCollapsed={(collapsed) => onToggleCollapsed(section.id, collapsed)}
								onSelectTab={(tabId) => onSelectTab(section.id, tabId)}
								onAddWidget={(tabId) => onAddWidget(section.id, tabId)}
							/>
						)
					})}
				</>
			)}
		</div>
	)
}
