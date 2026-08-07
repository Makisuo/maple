import { Link } from "@tanstack/react-router"

import { cn } from "@maple/ui/lib/utils"
import type { IconComponent } from "@/components/icons"

export interface NavShellItem<TId extends string> {
	id: TId
	label: string
	icon: IconComponent
}

/** Sibling pages that share the shell (rendered as router Links rather than tab buttons). */
export interface NavShellLink {
	id: string
	label: string
	icon: IconComponent
	to: string
}

export interface NavShellSection<TId extends string> {
	id: string
	title: string
	items: ReadonlyArray<NavShellItem<TId>>
	links?: ReadonlyArray<NavShellLink>
}

/**
 * A 2px lane is painted only on the active row, so rows share one vertical line
 * whether or not they are selected.
 */
const rowClass = (isActive: boolean) =>
	cn(
		"group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors text-left",
		isActive
			? "bg-accent text-accent-foreground font-medium"
			: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
	)

function ActiveIndicator() {
	return <span aria-hidden className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-primary" />
}

/**
 * Sidebar chrome shared by the settings-style pages (`/settings`, `/integrations`, `/account`).
 *
 * Only rows and their grouping live here. Which rows are visible, and what the tab union is,
 * stays with each page's own nav module — `/settings` filters on org permissions and billing
 * entitlements, `/account` shows every tab to any signed-in user. Keeping the two unions apart
 * is what stops account tabs from leaking into the org page's search schema.
 */
export function SettingsNavShell<TId extends string>({
	sections,
	active,
	onSelectTab,
}: {
	sections: ReadonlyArray<NavShellSection<TId>>
	/** Active tab id, or a link id when a sibling page renders the nav. */
	active: string
	onSelectTab: (tab: TId) => void
}) {
	return (
		<nav className="flex flex-col gap-5">
			{sections.map((section) => (
				<div key={section.id} className="flex flex-col gap-1">
					<div className="px-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/60">
						{section.title}
					</div>
					<div className="flex flex-col gap-0.5">
						{section.items.map((item) => {
							const isActive = item.id === active
							return (
								<button
									key={item.id}
									type="button"
									onClick={() => onSelectTab(item.id)}
									className={rowClass(isActive)}
								>
									{isActive && <ActiveIndicator />}
									<item.icon size={16} className="shrink-0" />
									{item.label}
								</button>
							)
						})}
						{section.links?.map((link) => {
							const isActive = link.id === active
							return (
								<Link key={link.to} to={link.to} className={rowClass(isActive)}>
									{isActive && <ActiveIndicator />}
									<link.icon size={16} className="shrink-0" />
									{link.label}
								</Link>
							)
						})}
					</div>
				</div>
			))}
		</nav>
	)
}
