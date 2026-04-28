import { createFileRoute } from "@tanstack/react-router"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { MetricsOverview } from "@/components/metrics/metrics-overview"

export const Route = createFileRoute("/metrics")({
	component: MetricsPage,
})

function MetricsPage() {
	return (
		<DashboardLayout
			breadcrumbs={[{ label: "Metrics" }]}
			title="Metrics"
			description="Explore and analyze OpenTelemetry metrics from your services."
		>
			<MetricsOverview />
		</DashboardLayout>
	)
}
