import { cn } from "@maple/ui/lib/utils"
import { Button } from "@maple/ui/components/ui/button"
import { PlusIcon, TrashIcon } from "@/components/icons"

import { InlineEditableText } from "@/components/dashboard-builder/sections/inline-editable-text"
import type { DashboardSectionTab } from "@maple/widgets/dashboard"

interface SectionTabBarProps {
	tabs: ReadonlyArray<DashboardSectionTab>
	activeTabId: string
	editable: boolean
	onSelect: (tabId: string) => void
	onRename: (tabId: string, title: string) => void
	onDelete: (tabId: string) => void
	onAddTab: () => void
}

/**
 * The tab strip for a section with two or more tabs.
 *
 * Not built on the shared `Tabs` primitive: that owns its own panel mounting,
 * and the whole point here is that only the active tab's widgets are ever
 * mounted — the section renders one grid and swaps its contents, rather than
 * keeping a panel per tab alive. What is shared is the visual language of the
 * `underline` tabs variant.
 */
export function SectionTabBar({
	tabs,
	activeTabId,
	editable,
	onSelect,
	onRename,
	onDelete,
	onAddTab,
}: SectionTabBarProps) {
	return (
		<div className="flex min-w-0 items-center gap-1 overflow-x-auto" role="tablist">
			{tabs.map((tab) => {
				const isActive = tab.id === activeTabId
				return (
					<div
						key={tab.id}
						className={cn(
							"group/tab flex shrink-0 items-center gap-1 border-b-2 px-2 py-1 text-xs transition-colors",
							isActive
								? "border-primary text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground",
						)}
					>
						<button
							type="button"
							role="tab"
							aria-selected={isActive}
							onClick={() => onSelect(tab.id)}
							className="min-w-0 cursor-pointer truncate font-medium outline-none"
						>
							<InlineEditableText
								value={tab.title}
								ariaLabel={`Rename tab ${tab.title}`}
								readOnly={!editable}
								onChange={(title) => onRename(tab.id, title)}
								className="text-xs font-medium"
							/>
						</button>
						{/* Hover-revealed so a read-only viewer, and the common case of
						    just switching tabs, never sees a destructive control. The
						    last tab can't be deleted — that's deleting the group. */}
						{editable && tabs.length > 1 && (
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={`Delete tab ${tab.title}`}
								className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/tab:opacity-100"
								onClick={() => onDelete(tab.id)}
							>
								<TrashIcon size={11} />
							</Button>
						)}
					</div>
				)
			})}
			{editable && (
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label="Add tab"
					className="shrink-0 text-muted-foreground"
					onClick={onAddTab}
				>
					<PlusIcon size={13} />
				</Button>
			)}
		</div>
	)
}
