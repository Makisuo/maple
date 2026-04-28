export interface InlineTraceData {
	id: string
	name: string
	durationMs: number
	hasError: boolean
	spanCount?: number
	services?: string[]
}

export interface InlineServiceData {
	name: string
	throughput?: number
	errorRate?: number
	p99Ms?: number
}

export interface InlineErrorData {
	errorType: string
	count: number
	affectedServices?: string[]
}

export interface InlineLogData {
	severity: string
	body: string
	serviceName?: string
	timestamp?: string
	traceId?: string
}

export type Segment =
	| { type: "text"; content: string }
	| { type: "trace"; data: InlineTraceData }
	| { type: "service"; data: InlineServiceData }
	| { type: "error"; data: InlineErrorData }
	| { type: "log"; data: InlineLogData }
