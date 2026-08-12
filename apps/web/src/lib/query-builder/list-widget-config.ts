import type { ValueUnit } from "@/components/dashboard-builder/types"

export type ListDataSource = "traces" | "logs"

export interface ListColumnDraft {
	field: string
	header: string
	unit?: ValueUnit
	align?: "left" | "center" | "right"
}

export const TRACE_DEFAULT_COLUMNS: ListColumnDraft[] = [
	{ field: "serviceName", header: "Service" },
	{ field: "spanName", header: "Span" },
	{ field: "durationMs", header: "Duration", unit: "duration_ms", align: "right" },
	{ field: "statusCode", header: "Status" },
]

export const LOG_DEFAULT_COLUMNS: ListColumnDraft[] = [
	{ field: "timestamp", header: "Time" },
	{ field: "severityText", header: "Severity" },
	{ field: "serviceName", header: "Service" },
	{ field: "body", header: "Message" },
]
