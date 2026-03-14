import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { useCustomer } from "autumn-js/react"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { BillingSection } from "@/components/settings/billing-section"
import { MembersSection } from "@/components/settings/members-section"
import { OrgTinybirdSettingsSection } from "@/components/settings/org-tinybird-settings-section"
import { hasBringYourOwnCloudAddOn } from "@/lib/billing/plan-gating"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

const SettingsSearch = Schema.Struct({
  tab: Schema.optionalWith(
    Schema.Literal("members", "billing", "data-platform"),
    { default: () => "members" as const },
  ),
})

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
  validateSearch: Schema.standardSchemaV1(SettingsSearch),
})

export function SettingsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const sessionResult = useAtomValue(MapleApiAtomClient.query("auth", "session", {}))
  const { customer, isLoading: isCustomerLoading } = useCustomer()

  const isAdmin = Result.builder(sessionResult)
    .onSuccess((session) =>
      session.roles.some((role) => role === "root" || role === "org:admin"),
    )
    .orElse(() => false)
  const canAccessDataPlatform = isAdmin && hasBringYourOwnCloudAddOn(customer)

  const availableTabs = isClerkAuthEnabled
    ? (canAccessDataPlatform ? ["members", "billing", "data-platform"] : ["members", "billing"])
    : (canAccessDataPlatform ? ["data-platform"] : [])
  const activeTab = availableTabs.includes(search.tab) ? search.tab : availableTabs[0]

  if (Result.isInitial(sessionResult) || (isAdmin && isCustomerLoading)) {
    return (
      <DashboardLayout
        breadcrumbs={[{ label: "Settings" }]}
        title="Settings"
        description="Manage your workspace settings."
      >
        <div className="max-w-2xl space-y-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-40 w-full" />
        </div>
      </DashboardLayout>
    )
  }

  if (availableTabs.length === 0) {
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
      breadcrumbs={[{ label: "Settings" }]}
      title="Settings"
      description="Manage your workspace settings."
    >
      <Tabs
        value={activeTab}
        onValueChange={(tab) =>
          navigate({ search: { tab: tab as "members" | "billing" | "data-platform" } })
        }
      >
        <TabsList variant="line">
          {availableTabs.includes("members") ? <TabsTrigger value="members">Members</TabsTrigger> : null}
          {availableTabs.includes("billing") ? <TabsTrigger value="billing">Usage & Billing</TabsTrigger> : null}
          {availableTabs.includes("data-platform") ? <TabsTrigger value="data-platform">Data Platform</TabsTrigger> : null}
        </TabsList>
        {availableTabs.includes("members") ? (
          <TabsContent value="members" className="pt-4">
            <MembersSection />
          </TabsContent>
        ) : null}
        {availableTabs.includes("billing") ? (
          <TabsContent value="billing" className="pt-4">
            <BillingSection />
          </TabsContent>
        ) : null}
        {availableTabs.includes("data-platform") ? (
          <TabsContent value="data-platform" className="pt-4">
            <OrgTinybirdSettingsSection isAdmin={isAdmin} hasEntitlement={canAccessDataPlatform} />
          </TabsContent>
        ) : null}
      </Tabs>
    </DashboardLayout>
  )
}
