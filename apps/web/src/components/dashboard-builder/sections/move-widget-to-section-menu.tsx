import {
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { LayersIcon } from "@/components/icons"
import type { SectionTarget } from "@maple/domain/http"

import type { DashboardSection } from "@/components/dashboard-builder/types"

interface MoveWidgetToSectionMenuProps {
	sections: DashboardSection[]
	/** Where the widget lives now, so its own container reads as disabled. */
	current: SectionTarget
	onMove: (target: SectionTarget) => void
}

/**
 * "Move to…" submenu for the widget kebab.
 *
 * This is how a tile changes group: separate grids can't share a drag context
 * without pulling in a second drag library, so dragging between groups is out
 * and an explicit menu is in. Destinations read as `Group · Tab` so a section
 * with tabs is unambiguous, and the widget's current container is disabled
 * rather than hidden — a greyed "you're already here" is easier to read than a
 * list that silently changes length.
 */
export function MoveWidgetToSectionMenu({ sections, current, onMove }: MoveWidgetToSectionMenuProps) {
	if (sections.length === 0) return null

	const isCurrent = (target: SectionTarget) =>
		target === null
			? current === null
			: current !== null && current.sectionId === target.sectionId && current.tabId === target.tabId

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<LayersIcon size={14} />
				Move to
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent>
				<DropdownMenuItem disabled={isCurrent(null)} onClick={() => onMove(null)}>
					Ungrouped
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				{sections.flatMap((section) =>
					section.tabs.map((tab) => {
						const target = { sectionId: section.id, tabId: tab.id }
						return (
							<DropdownMenuItem
								key={`${section.id}:${tab.id}`}
								disabled={isCurrent(target)}
								onClick={() => onMove(target)}
							>
								{/* One tab means the header is the label, so repeating it
								    would read as "Overview · Overview". */}
								{section.tabs.length === 1 ? section.title : `${section.title} · ${tab.title}`}
							</DropdownMenuItem>
						)
					}),
				)}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	)
}
