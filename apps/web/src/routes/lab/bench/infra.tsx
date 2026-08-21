import { createFileRoute } from "@tanstack/react-router"

import { InfraChartBench } from "@/lab/bench/infra-chart-bench"

/**
 * The `?mode=` search param is gone along with the Recharts arm it selected.
 * It chose between the linked cursor and Recharts' hover-sync event bus as the
 * render-storm baseline; the infra charts no longer have a Recharts path, so
 * there is nothing to A/B and the bench measures the one implementation.
 */
export const Route = createFileRoute("/lab/bench/infra")({
	component: InfraBenchPage,
})

function InfraBenchPage() {
	return <InfraChartBench />
}
