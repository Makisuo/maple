import { Navigate, useNavigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { BillingSection } from "@/components/settings/billing-section"
import { MembersSection } from "@/components/settings/members-section"
import { IngestionSection } from "@/components/settings/ingestion-section"
import { ApiKeysSection } from "@/components/settings/api-keys-section"
import { DeveloperSection } from "@/components/settings/developer-section"
import { McpSection } from "@/components/settings/mcp-section"
import { NotificationsSection } from "@/components/settings/notifications-section"
import { AutomationSection } from "@/components/settings/automation-section"
import { OrgClickHouseSettingsSection } from "@/components/settings/org-clickhouse-settings-section"
import { OrganizationSection } from "@/components/settings/organization-section"
import { SetupAuditSection } from "@/components/settings/setup-audit-section"
import {
	resolveActiveSettingsTab,
	SettingsNav,
	settingsTabLabels,
	settingsTabValues,
	useVisibleSettingsSections,
	type SettingsTab,
} from "@/components/settings/settings-nav"

/** Pre-hub tabs that moved to /integrations — kept decodable so old deep links redirect. */
const legacyTabValues = ["connectors", "integrations", "escalations", "ai"] as const

const SettingsSearch = Schema.Struct({
	tab: Schema.optional(Schema.Literals([...settingsTabValues, ...legacyTabValues])),
})

export const Route = createFileRoute("/settings")({
	component: SettingsPage,
	validateSearch: Schema.toStandardSchemaV1(SettingsSearch),
})

function SettingsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const {
		visibleSections,
		visibleItems,
		isAdmin,
		canAccessDataPlatform,
		canAccessAi,
		isCustomerLoading,
		isLoading,
	} = useVisibleSettingsSections()

	// Pre-hub deep links: these tabs moved to the Integrations hub.
	if (search.tab === "connectors" || search.tab === "integrations") {
		return <Navigate to="/integrations" replace />
	}
	if (search.tab === "escalations" || search.tab === "ai") {
		return <Navigate to="/settings" search={{ tab: "automation" }} replace />
	}

	const activeTab = resolveActiveSettingsTab(search.tab, visibleItems)

	function handleTabSelect(tab: SettingsTab) {
		navigate({ search: { tab } })
	}

	// `data-platform` is the only tab whose visibility depends on the billing
	// customer, so deep-linking there while it loads would briefly show the first
	// tab before flipping. Hold the skeleton just for that case; every other tab
	// renders as soon as the session resolves.
	const waitingForGatedTab = search.tab === "data-platform" && isCustomerLoading

	if (isLoading || waitingForGatedTab) {
		return (
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[{ label: "Settings" }]} />
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								title="Settings"
								description="Manage your workspace settings."
							/>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="space-y-3">
								<Skeleton className="h-8 w-56" />
								<Skeleton className="h-40 w-full" />
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		)
	}

	if (visibleItems.length === 0) {
		return (
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs items={[{ label: "Settings" }]} />
				<DashboardLayout.Body>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header title="Settings" description="Workspace settings." />
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<p className="text-muted-foreground text-sm">
								No settings are available for the current account.
							</p>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		)
	}

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs
				items={[{ label: "Settings", href: "/settings" }, { label: settingsTabLabels[activeTab] }]}
			/>
			<DashboardLayout.Body>
				<DashboardLayout.Filters>
					<SettingsNav
						sections={visibleSections}
						active={activeTab}
						onSelectTab={handleTabSelect}
					/>
				</DashboardLayout.Filters>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header title={settingsTabLabels[activeTab]} />
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						{activeTab === "organization" && <OrganizationSection />}
						{activeTab === "members" && <MembersSection />}
						{activeTab === "setup-audit" && <SetupAuditSection />}
						{activeTab === "ingestion" && <IngestionSection />}
						{activeTab === "api-keys" && <ApiKeysSection />}
						{activeTab === "developer" && (
							<DeveloperSection onNavigateToApiKeys={() => handleTabSelect("api-keys")} />
						)}
						{activeTab === "mcp" && <McpSection />}
						{activeTab === "notifications" && <NotificationsSection />}
						{activeTab === "automation" && (
							<AutomationSection isAdmin={isAdmin} hasEntitlement={canAccessAi} />
						)}
						{activeTab === "billing" && <BillingSection isAdmin={isAdmin} />}
						{activeTab === "data-platform" && (
							<OrgClickHouseSettingsSection
								isAdmin={isAdmin}
								hasEntitlement={canAccessDataPlatform}
							/>
						)}
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
