import { useState } from "react"
import { ChevronDownIcon } from "@maple/ui/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { cn } from "@maple/ui/lib/utils"
import { ArrowUpIcon, DotsVerticalIcon, PlusIcon, TrashIcon } from "@/components/icons"

import { DashboardGrid } from "@/components/dashboard-builder/canvas/dashboard-canvas"
import type { GridTier } from "@/components/dashboard-builder/canvas/grid-breakpoints"
import { InlineEditableText } from "@/components/dashboard-builder/sections/inline-editable-text"
import { SectionTabBar } from "@/components/dashboard-builder/sections/section-tab-bar"
import { DeleteSectionDialog, DeleteTabDialog } from "@/components/dashboard-builder/sections/section-dialogs"
import { useDashboardActions } from "@/components/dashboard-builder/dashboard-actions-context"
import type { DashboardSection, DashboardWidget } from "@/components/dashboard-builder/types"

interface DashboardSectionViewProps {
	section: DashboardSection
	/** Widgets in this section's active tab, already filtered by the parent. */
	widgets: DashboardWidget[]
	/** Every widget in the section, across tabs — for the delete confirmations. */
	sectionWidgetCount: number
	activeTabId: string
	collapsed: boolean
	index: number
	sectionCount: number
	width: number
	tier: GridTier
	editable: boolean
	onToggleCollapsed: (collapsed: boolean) => void
	onSelectTab: (tabId: string) => void
	onAddWidget: (tabId: string) => void
	/** Widgets in a specific tab — for the tab delete confirmation's count. */
	widgetCountInTab: (tabId: string) => number
}

/**
 * One collapsible widget group.
 *
 * The two behaviours that matter here are both about *not mounting*: a collapsed
 * section renders its header and returns, and an expanded one renders only its
 * active tab's widgets. Because `useWidgetData` lives inside each tile, not
 * mounting is what stops the query — no `enabled={false}` plumbing, and strictly
 * stronger than hiding with CSS, which would leave the tile fetching.
 */
export function DashboardSectionView({
	section,
	widgets,
	sectionWidgetCount,
	activeTabId,
	collapsed,
	index,
	sectionCount,
	width,
	tier,
	editable,
	onToggleCollapsed,
	onSelectTab,
	onAddWidget,
	widgetCountInTab,
}: DashboardSectionViewProps) {
	const {
		renameSection,
		setSectionCollapsedDefault,
		setSectionCollapsible,
		reorderSections,
		deleteSection,
		addTab,
		renameTab,
		deleteTab,
	} = useDashboardActions()

	const [deleteSectionOpen, setDeleteSectionOpen] = useState(false)
	const [tabPendingDelete, setTabPendingDelete] = useState<string | null>(null)

	// A tab bar only earns its space at two or more tabs. With one, the section
	// header *is* the tab label, and the store keeps the two titles in sync.
	const hasTabs = section.tabs.length >= 2
	// Absent means collapsible — only an explicit `false` pins the group open.
	const collapsible = section.collapsible !== false
	const pendingTab = section.tabs.find((tab) => tab.id === tabPendingDelete)
	const destinationTab = section.tabs.find((tab) => tab.id !== tabPendingDelete)

	return (
		<section className="mb-2">
			<div className="flex items-center gap-2 border-b py-2">
				{/* A pinned-open group has no chevron at all rather than a disabled one:
				    a control that can't do anything reads as broken. The spacer keeps
				    its title aligned with every collapsible sibling's. */}
				{collapsible ? (
					<Button
						variant="ghost"
						size="icon-xs"
						aria-expanded={!collapsed}
						aria-label={collapsed ? `Expand ${section.title}` : `Collapse ${section.title}`}
						onClick={() => onToggleCollapsed(!collapsed)}
					>
						<ChevronDownIcon
							className={cn("transition-transform duration-150", collapsed && "-rotate-90")}
							size={14}
						/>
					</Button>
				) : (
					<div className="size-6 shrink-0" aria-hidden />
				)}

				<InlineEditableText
					value={section.title}
					ariaLabel={`Rename group ${section.title}`}
					readOnly={!editable}
					onChange={(title) => renameSection(section.id, title)}
					className="truncate text-sm font-semibold"
				/>

				{hasTabs && !collapsed && (
					<div className="ml-2 min-w-0 flex-1">
						<SectionTabBar
							tabs={section.tabs}
							activeTabId={activeTabId}
							editable={editable}
							onSelect={onSelectTab}
							onRename={(tabId, title) => renameTab(section.id, tabId, title)}
							onDelete={(tabId) => setTabPendingDelete(tabId)}
							onAddTab={() => addTab(section.id)}
						/>
					</div>
				)}

				<div className={cn("flex items-center gap-1", !hasTabs && "ml-auto")}>
					{editable && !collapsed && (
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label={`Add widget to ${section.title}`}
							onClick={() => onAddWidget(activeTabId)}
						>
							<PlusIcon size={14} />
						</Button>
					)}
					{editable && (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label={`${section.title} options`}
									>
										<DotsVerticalIcon size={14} />
									</Button>
								}
							/>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onClick={() => addTab(section.id)}>
									<PlusIcon size={14} />
									Add tab
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={index === 0}
									onClick={() => reorderSections(index, index - 1)}
								>
									<ArrowUpIcon size={14} />
									Move up
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={index === sectionCount - 1}
									onClick={() => reorderSections(index, index + 1)}
								>
									<ArrowUpIcon size={14} className="rotate-180" />
									Move down
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								{/* The stored default, distinct from this viewer's own
								    collapse — which lives in their URL and changes nothing
								    for anyone else. Meaningless on a pinned-open group, so
								    it is hidden rather than left there doing nothing. */}
								{collapsible && (
									<DropdownMenuItem
										onClick={() =>
											setSectionCollapsedDefault(
												section.id,
												!(section.collapsed ?? false),
											)
										}
									>
										{section.collapsed ? "Expanded by default" : "Collapsed by default"}
									</DropdownMenuItem>
								)}
								<DropdownMenuItem
									onClick={() => setSectionCollapsible(section.id, !collapsible)}
								>
									{collapsible ? "Always expanded" : "Allow collapsing"}
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									variant="destructive"
									onClick={() => setDeleteSectionOpen(true)}
								>
									<TrashIcon size={14} />
									Delete group…
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</div>

			{/* Collapsed renders nothing at all — no grid, no tiles, no queries. */}
			{!collapsed &&
				(widgets.length === 0 ? (
					<p className="px-1 py-6 text-xs text-muted-foreground">
						{editable ? "No widgets in this group yet." : "No widgets in this group."}
					</p>
				) : (
					<div className="pt-2">
						<DashboardGrid widgets={widgets} width={width} tier={tier} editable={editable} />
					</div>
				))}

			<DeleteSectionDialog
				open={deleteSectionOpen}
				onOpenChange={setDeleteSectionOpen}
				sectionTitle={section.title}
				widgetCount={sectionWidgetCount}
				onConfirm={(action) => deleteSection(section.id, action)}
			/>

			{pendingTab && destinationTab && (
				<DeleteTabDialog
					open
					onOpenChange={(open) => {
						if (!open) setTabPendingDelete(null)
					}}
					tabTitle={pendingTab.title}
					destinationTitle={destinationTab.title}
					widgetCount={widgetCountInTab(pendingTab.id)}
					onConfirm={(action) => deleteTab(section.id, pendingTab.id, action)}
				/>
			)}
		</section>
	)
}
