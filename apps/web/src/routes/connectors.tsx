import { createFileRoute } from "@tanstack/react-router"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ScrapeTargetsSection } from "@/components/settings/scrape-targets-section"

export const Route = createFileRoute("/connectors")({
  component: ConnectorsPage,
})

function ConnectorsPage() {
  return (
    <DashboardLayout
      breadcrumbs={[{ label: "Connectors" }]}
      title="Connectors"
      description="Connect external data sources to ingest metrics alongside your OpenTelemetry data."
    >
      <div className="max-w-2xl space-y-6">
        <ScrapeTargetsSection />
      </div>
    </DashboardLayout>
  )
}
