import { useMapleCustomer } from "@/hooks/use-maple-customer"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { hasBringYourOwnCloudAddOn } from "@/lib/billing/plan-gating"
import { useOrganizationFeatureFlags } from "@/hooks/use-organization-feature-flags"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
	BellIcon,
	CircleCheckIcon,
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
import { SettingsNavShell } from "@/components/settings/settings-nav-shell"

export const settingsTabValues = [
	"organization",
	"members",
	"setup-audit",
	"ingestion",
	"api-keys",
	"developer",
	"mcp",
	"notifications",
	"automation",
	"billing",
	"data-platform",
] as const
export type SettingsTab = (typeof settingsTabValues)[number]

export const settingsTabLabels: Record<SettingsTab, string> = {
	organization: "Organization",
	members: "Members",
	"setup-audit": "Setup Audit",
	ingestion: "Ingestion",
	"api-keys": "API Keys",
	developer: "API Reference",
	mcp: "MCP",
	notifications: "Notifications",
	automation: "Automation",
	billing: "Billing",
	"data-platform": "Data Platform",
}

interface NavItem {
	id: SettingsTab
	label: string
	icon: IconComponent
}

/**
 * Preference order for the landing tab when `/settings` is opened with no `?tab=`, most-preferred
 * first. `organization` is the Clerk-workspace landing tab; `ingestion` is the self-hosted one, where
 * `organization` is filtered out.
 *
 * This is declared rather than inferred from nav position on purpose: a positional default silently
 * moves whenever an item is added. `setup-audit` is deliberately not Clerk-gated, so in self-hosted
 * mode it is the only surviving Workspace item — as the first visible item it would have become the
 * landing tab and run the audit's dozen warehouse reads on every visit to Settings.
 *
 * Never list a tab here whose section does expensive work on mount.
 */
export const DEFAULT_SETTINGS_TAB_ORDER: ReadonlyArray<SettingsTab> = ["organization", "ingestion"]

/**
 * Which tab `/settings` should render: the requested one when it is actually visible, else the first
 * available preferred default, else whatever is on offer.
 */
export function resolveActiveSettingsTab(
	requestedTab: string | undefined,
	visibleItems: ReadonlyArray<NavItem>,
): SettingsTab {
	const requested = visibleItems.find((item) => item.id === requestedTab)?.id
	if (requested !== undefined) return requested
	const preferred = DEFAULT_SETTINGS_TAB_ORDER.find((tab) => visibleItems.some((item) => item.id === tab))
	return preferred ?? visibleItems[0]?.id ?? "ingestion"
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
			// Spans alerting, ingestion and integrations, so it sits at workspace level rather than
			// under any one of them.
			{ id: "setup-audit", label: "Setup Audit", icon: CircleCheckIcon },
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
			{ id: "automation", label: "Automation", icon: ShieldIcon },
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
	// Shared with the main sidebar and the flagged routes, so a flag can't be read
	// one way here and another way there (it already force-enables when self-hosted,
	// which is what the `!isClerkAuthEnabled` branch below used to do inline).
	const featureFlags = useOrganizationFeatureFlags()

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
	const canAccessAi = isAdmin && featureFlags.aiAutoTriage

	const dataSections = navSections
		.map((section) => ({
			...section,
			items: section.items.filter((item) => {
				if (item.id === "data-platform") return canAccessDataPlatform
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
	return <SettingsNavShell sections={sections} active={active} onSelectTab={onSelectTab} />
}
