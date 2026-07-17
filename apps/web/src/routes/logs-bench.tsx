import { createFileRoute } from "@tanstack/react-router"

import { LogsTableBench } from "@/components/logs/logs-table-bench"

export const Route = createFileRoute("/logs-bench")({ component: LogsBenchPage })

function LogsBenchPage() {
	if (!import.meta.env.DEV) return null
	return <LogsTableBench />
}
