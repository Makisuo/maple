import { createFileRoute } from "@tanstack/react-router"

import { ServiceDetailChartBench } from "@/components/services/service-detail-chart-bench"

export const Route = createFileRoute("/overview-bench")({ component: OverviewBenchPage })

function OverviewBenchPage() {
	if (!import.meta.env.DEV) return null
	return <ServiceDetailChartBench syncMode="cursor" />
}
