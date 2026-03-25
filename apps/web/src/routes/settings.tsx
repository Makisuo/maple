import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { useCustomer } from "autumn-js/react"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { BillingSection } from "@/components/settings/billing-section"
import { MembersSection } from "@/components/settings/members-section"
import { IngestionSection } from "@/components/settings/ingestion-section"
import { ApiKeysSection } from "@/components/settings/api-keys-section"
import { McpSection } from "@/components/settings/mcp-section"
import { ConnectorsSection } from "@/components/settings/connectors-section"
import { OrgTinybirdSettingsSection } from "@/components/settings/org-tinybird-settings-section"
import { hasBringYourOwnCloudAddOn } from "@/lib/billing/plan-gating"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
  UserIcon,
  ServerIcon,
  KeyIcon,
  CreditCardIcon,
  DatabaseIcon,
  CodeIcon,
  type IconComponent,
} from "@/components/icons"
import { cn } from "@maple/ui/utils"

const tabValues = ["members", "ingestion", "api-keys", "mcp", "connectors", "billing", "data-platform"] as const
type SettingsTab = (typeof tabValues)[number]

const SettingsSearch = Schema.Struct({
  tab: Schema.optional(Schema.Literals(tabValues)),
})

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
  validateSearch: Schema.toStandardSchemaV1(SettingsSearch),
})

interface NavItem {
  id: SettingsTab
  label: string
  icon: IconComponent

}

const allNavItems: NavItem[] = [
  { id: "members", label: "Members", icon: UserIcon },
  { id: "ingestion", label: "Ingestion", icon: ServerIcon },
  { id: "api-keys", label: "API Keys", icon: KeyIcon },
  { id: "mcp", label: "MCP", icon: CodeIcon },
  { id: "connectors", label: "Connectors", icon: DatabaseIcon },
  { id: "billing", label: "Billing", icon: CreditCardIcon },
  { id: "data-platform", label: "Data Platform", icon: DatabaseIcon },
]

function SettingsNav({
  items,
  activeTab,
  onSelect,
}: {
  items: NavItem[]
  activeTab: SettingsTab
  onSelect: (tab: SettingsTab) => void
}) {
  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((item) => {
        const isActive = item.id === activeTab
        return (
          <button
            key={item.id}
            onClick={() => onSelect(item.id)}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors text-left",
              isActive
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <item.icon size={16} className="shrink-0" />
            {item.label}
          </button>
        )
      })}
    </nav>
  )
}

const tabLabels: Record<SettingsTab, string> = {
  members: "Members",
  ingestion: "Ingestion",
  "api-keys": "API Keys",
  mcp: "MCP",
  connectors: "Connectors",
  billing: "Billing",
  "data-platform": "Data Platform",
}

export function SettingsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const sessionResult = useAtomValue(MapleApiAtomClient.query("auth", "session", {}))
  const { data: customer, isLoading: isCustomerLoading } = useCustomer()

  const isAdmin = Result.builder(sessionResult)
    .onSuccess((session) =>
      session.roles.some((role) => role === "root" || role === "org:admin"),
    )
    .orElse(() => false)
  const canAccessDataPlatform = isAdmin && hasBringYourOwnCloudAddOn(customer)

  // Build visible nav items based on permissions
  const visibleItems = allNavItems.filter((item) => {
    if (item.id === "members" || item.id === "billing") return isClerkAuthEnabled
    if (item.id === "data-platform") return canAccessDataPlatform
    return true
  })

  const activeTab: SettingsTab = (
    visibleItems.some((i) => i.id === search.tab)
      ? search.tab
      : visibleItems[0]?.id ?? "ingestion"
  ) as SettingsTab

  function handleTabSelect(tab: SettingsTab) {
    navigate({ search: { tab } })
  }

  if (Result.isInitial(sessionResult) || (isAdmin && isCustomerLoading)) {
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
      breadcrumbs={[
        { label: "Settings", href: "/settings" },
        { label: tabLabels[activeTab] },
      ]}
      title={tabLabels[activeTab]}
      filterSidebar={
        <SettingsNav
          items={visibleItems}
          activeTab={activeTab}
          onSelect={handleTabSelect}
        />
      }
    >
      {activeTab === "members" && <MembersSection />}
      {activeTab === "ingestion" && <IngestionSection />}
      {activeTab === "api-keys" && <ApiKeysSection />}
      {activeTab === "mcp" && <McpSection />}
      {activeTab === "connectors" && <ConnectorsSection />}
      {activeTab === "billing" && <BillingSection />}
      {activeTab === "data-platform" && (
        <OrgTinybirdSettingsSection isAdmin={isAdmin} hasEntitlement={canAccessDataPlatform} />
      )}
    </DashboardLayout>
  )
}
