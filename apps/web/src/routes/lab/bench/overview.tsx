import { createFileRoute } from "@tanstack/react-router"

import { ServiceDetailChartBench } from "@/lab/bench/service-detail-chart-bench"

export const Route = createFileRoute("/lab/bench/overview")({ component: OverviewBenchPage })

function OverviewBenchPage() {
	return <ServiceDetailChartBench />
}
