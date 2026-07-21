import { Link } from "@tanstack/react-router"
import { useOrganization } from "@clerk/clerk-react"
import { useMapleCustomer } from "@/hooks/use-maple-customer"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { hasBringYourOwnCloudAddOn } from "@/lib/billing/plan-gating"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
	BellIcon,
	ChatBubbleSparkleIcon,
	CodeIcon,
	CreditCardIcon,
	DatabaseIcon,
	GearIcon,
	GridIcon,
	KeyIcon,
	ServerIcon,
	ShieldIcon,
	SquareTerminalIcon,
	UserIcon,
	type IconComponent,
} from "@/components/icons"
import { cn } from "@maple/ui/utils"

export const settingsTabValues = [
	"organization",
	"members",
	"ingestion",
	"api-keys",
	"developer",
	"mcp",
	"notifications",
	"escalations",
	"ai",
	"billing",
	"data-platform",
] as const
export type SettingsTab = (typeof settingsTabValues)[number]

export const settingsTabLabels: Record<SettingsTab, string> = {
	organization: "Organization",
	members: "Members",
	ingestion: "Ingestion",
	"api-keys": "API Keys",
	developer: "API Reference",
	mcp: "MCP",
	notifications: "Notifications",
	escalations: "Escalations",
	ai: "AI",
	billing: "Billing",
	"data-platform": "Data Platform",
}

interface NavItem {
	id: SettingsTab
	label: string
	icon: IconComponent
}

/** Sibling pages that share the settings shell (rendered as router Links). */
interface NavLinkItem {
	id: "integrations"
	label: string
	icon: IconComponent
	to: string
}

export interface SettingsNavSection {
	id: "workspace" | "data" | "behavior" | "infra"
	title: string
	items: NavItem[]
	links?: NavLinkItem[]
}

const navSections: SettingsNavSection[] = [
	{
		id: "workspace",
		title: "Workspace",
		items: [
			{ id: "organization", label: "Organization", icon: GearIcon },
			{ id: "members", label: "Members", icon: UserIcon },
			{ id: "billing", label: "Billing", icon: CreditCardIcon },
		],
	},
	{
		id: "data",
		title: "Data",
		items: [
			{ id: "ingestion", label: "Ingestion", icon: ServerIcon },
			{ id: "api-keys", label: "API Keys", icon: KeyIcon },
			{ id: "developer", label: "API Reference", icon: CodeIcon },
			{ id: "mcp", label: "MCP", icon: SquareTerminalIcon },
		],
		links: [{ id: "integrations", label: "Integrations", icon: GridIcon, to: "/integrations" }],
	},
	{
		id: "behavior",
		title: "Behavior",
		items: [
			{ id: "notifications", label: "Notifications", icon: BellIcon },
			{ id: "escalations", label: "Escalations", icon: ShieldIcon },
			{ id: "ai", label: "AI", icon: ChatBubbleSparkleIcon },
		],
	},
	{
		id: "infra",
		title: "Infrastructure",
		items: [{ id: "data-platform", label: "Data Platform", icon: DatabaseIcon }],
	},
]

/**
 * Permission-filtered settings nav sections, shared by /settings and the
 * /integrations hub (which renders the same sidebar).
 */
export function useVisibleSettingsSections() {
	// Hooks run unconditionally (rules of hooks); their results are only consumed
	// in the Clerk-auth path below. `isClerkAuthEnabled` is a build-time constant
	// today, but keeping the hooks above the early return avoids a conditional-hook
	// hazard if it ever becomes dynamic.
	const sessionResult = useAtomValue(MapleApiAtomClient.query("auth", "session", {}))
	const isAdmin = useIsOrgAdmin()
	const { data: customer, isLoading: isCustomerLoading } = useMapleCustomer()
	const { organization } = useOrganization()

	const visibleSections = navSections
		.map((section) => ({
			...section,
			items: section.items.filter((item) => {
				if (
					item.id === "organization" ||
					item.id === "members" ||
					item.id === "billing" ||
					item.id === "notifications"
				) {
					return isClerkAuthEnabled
				}
				return true
			}),
		}))
		.filter((section) => section.items.length > 0 || (section.links?.length ?? 0) > 0)

	if (!isClerkAuthEnabled) {
		return {
			visibleSections,
			visibleItems: visibleSections.flatMap((s) => s.items),
			isAdmin: true,
			canAccessDataPlatform: true,
			canAccessAi: true,
			isCustomerLoading: false,
			isLoading: false,
		}
	}

	const canAccessDataPlatform = isAdmin && hasBringYourOwnCloudAddOn(customer)
	const hasAiMetadataFlag = organization?.publicMetadata?.bringyourownai === true
	const canAccessAi = isAdmin && hasAiMetadataFlag

	const dataSections = navSections
		.map((section) => ({
			...section,
			items: section.items.filter((item) => {
				if (item.id === "data-platform") return canAccessDataPlatform
				if (item.id === "ai") return canAccessAi
				return true
			}),
		}))
		.filter((section) => section.items.length > 0 || (section.links?.length ?? 0) > 0)

	return {
		visibleSections: dataSections,
		visibleItems: dataSections.flatMap((s) => s.items),
		isAdmin,
		canAccessDataPlatform,
		canAccessAi,
		isCustomerLoading,
		// The shell only waits on the (fast) session query. The billing customer —
		// dominated by an upstream Autumn round-trip — keeps loading in the
		// background; `canAccessDataPlatform` stays false until it resolves, so the
		// "Data Platform" nav item just appears when ready (same as /integrations),
		// instead of blocking the whole page behind it.
		isLoading: Result.isInitial(sessionResult),
	}
}

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

export function SettingsNav({
	sections,
	active,
	onSelectTab,
}: {
	sections: SettingsNavSection[]
	/** Active settings tab, or "integrations" when the hub page renders the nav. */
	active: SettingsTab | "integrations"
	onSelectTab: (tab: SettingsTab) => void
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
