import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@maple/ui/components/ui/tabs"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { BillingSection } from "@/components/settings/billing-section"
import { MembersSection } from "@/components/settings/members-section"

const SettingsSearch = Schema.Struct({
  tab: Schema.optionalWith(
    Schema.Literal("members", "billing"),
    { default: () => "members" as const },
  ),
})

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
  validateSearch: Schema.standardSchemaV1(SettingsSearch),
})

function SettingsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  if (!isClerkAuthEnabled) {
    return (
      <DashboardLayout
        breadcrumbs={[{ label: "Settings" }]}
        title="Settings"
        description="Workspace settings."
      >
        <p className="text-muted-foreground text-sm">
          No additional settings to configure in self-hosted mode.
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
        value={search.tab}
        onValueChange={(tab) =>
          navigate({ search: { tab: tab as "members" | "billing" } })
        }
      >
        <TabsList variant="line">
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="billing">Usage & Billing</TabsTrigger>
        </TabsList>
        <TabsContent value="members" className="pt-4">
          <MembersSection />
        </TabsContent>
        <TabsContent value="billing" className="pt-4">
          <BillingSection />
        </TabsContent>
      </Tabs>
    </DashboardLayout>
  )
}
