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
import { EscalationPolicySection } from "@/components/settings/escalation-policy-section"
import { AiTriageSettingsSection } from "@/components/settings/ai-triage-settings-section"
import { OrgClickHouseSettingsSection } from "@/components/settings/org-clickhouse-settings-section"
import { OrganizationSection } from "@/components/settings/organization-section"
import {
	SettingsNav,
	settingsTabLabels,
	settingsTabValues,
	useVisibleSettingsSections,
	type SettingsTab,
} from "@/components/settings/settings-nav"

/** Pre-hub tabs that moved to /integrations — kept decodable so old deep links redirect. */
const legacyTabValues = ["connectors", "integrations"] as const

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

	const activeTab: SettingsTab = (
		visibleItems.some((i) => i.id === search.tab) ? search.tab : (visibleItems[0]?.id ?? "ingestion")
	) as SettingsTab

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
			<DashboardLayout
				breadcrumbs={[{ label: "Settings" }]}
				title="Settings"
				description="Manage your workspace settings."
			>
				<div className="space-y-3">
					<Skeleton className="h-8 w-56" />
					<Skeleton className="h-40 w-full" />
				</div>
			</DashboardLayout>
		)
	}

	if (visibleItems.length === 0) {
		return (
			<DashboardLayout
				breadcrumbs={[{ label: "Settings" }]}
				title="Settings"
				description="Workspace settings."
			>
				<p className="text-muted-foreground text-sm">
					No settings are available for the current account.
				</p>
			</DashboardLayout>
		)
	}

	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: settingsTabLabels[activeTab] }]}
			title={settingsTabLabels[activeTab]}
			filterSidebar={
				<SettingsNav sections={visibleSections} active={activeTab} onSelectTab={handleTabSelect} />
			}
		>
			{activeTab === "organization" && <OrganizationSection />}
			{activeTab === "members" && <MembersSection />}
			{activeTab === "ingestion" && <IngestionSection />}
			{activeTab === "api-keys" && <ApiKeysSection />}
			{activeTab === "developer" && (
				<DeveloperSection onNavigateToApiKeys={() => handleTabSelect("api-keys")} />
			)}
			{activeTab === "mcp" && <McpSection />}
			{activeTab === "notifications" && <NotificationsSection />}
			{activeTab === "escalations" && <EscalationPolicySection isAdmin={isAdmin} />}
			{activeTab === "ai" && <AiTriageSettingsSection isAdmin={isAdmin} hasEntitlement={canAccessAi} />}
			{activeTab === "billing" && <BillingSection />}
			{activeTab === "data-platform" && (
				<OrgClickHouseSettingsSection isAdmin={isAdmin} hasEntitlement={canAccessDataPlatform} />
			)}
		</DashboardLayout>
	)
}
