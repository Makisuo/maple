import { createFileRoute } from "@tanstack/react-router"

import { LogsTableBench } from "@/lab/bench/logs-table-bench"

export const Route = createFileRoute("/lab/bench/logs")({ component: LogsTableBench })
