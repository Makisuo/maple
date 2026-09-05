import type { TraceId, SpanId } from "@maple/domain"

export interface TimeRange {
	readonly startTime: string
	readonly endTime: string
}

export interface ServiceSummary {
	readonly name: string
	readonly throughput: number
	readonly errorRate: number
	readonly errorCount: number
	readonly p50Ms: number
	readonly p95Ms: number
	readonly p99Ms: number
}

export interface ListServicesInput {
	readonly timeRange: TimeRange
	readonly environment?: string
}

export interface SpanResult {
	readonly traceId: TraceId
	readonly spanId: SpanId | null
	readonly spanName: string
	readonly serviceName: string
	readonly durationMs: number
	readonly statusCode: string
	readonly statusMessage: string
	readonly attributes: Record<string, string>
	readonly resourceAttributes: Record<string, string>
	readonly timestamp: string
}

export interface SearchTracesInput {
	readonly timeRange: TimeRange
	readonly service?: string
	readonly spanName?: string
	readonly spanNameMatchMode?: "exact" | "contains"
	readonly hasError?: boolean
	readonly minDurationMs?: number
	readonly maxDurationMs?: number
	readonly httpMethod?: string
	readonly traceId?: string
	readonly attributeFilters?: ReadonlyArray<{
		key: string
		value: string
		mode?: string
		negated?: boolean
	}>
	readonly rootOnly?: boolean
	readonly limit?: number
	readonly offset?: number
}

export interface SearchTracesOutput {
	readonly timeRange: TimeRange
	readonly spans: ReadonlyArray<SpanResult>
	readonly pagination: {
		readonly offset: number
		readonly limit: number
		readonly hasMore: boolean
	}
}

export interface SpanNode {
	readonly spanId: SpanId
	readonly parentSpanId: string
	readonly spanName: string
	readonly serviceName: string
	/** OTel span kind (e.g. "Server", "Client", "Internal"). Used to prioritise
	 * service-entry spans when bounding a large trace to an overview. */
	readonly spanKind: string
	readonly durationMs: number
	readonly statusCode: string
	readonly statusMessage: string
	readonly attributes: Record<string, string>
	readonly resourceAttributes: Record<string, string>
	readonly children: SpanNode[]
}

export interface InspectTraceOutput {
	readonly traceId: TraceId
	readonly serviceCount: number
	readonly spanCount: number
	readonly rootDurationMs: number
	readonly spans: ReadonlyArray<SpanNode>
	readonly logs: ReadonlyArray<{
		readonly timestamp: string
		readonly severityText: string
		readonly serviceName: string
		readonly body: string
		readonly spanId: string
	}>
}

export interface ErrorSummary {
	/** Stable fingerprint hash (the error identity; pass to error_detail). */
	readonly fingerprintHash: string
	/** Human-readable display label derived at ingest. */
	readonly label: string
	/** One occurrence's status message — what tells two fingerprints with the same label apart. */
	readonly sampleMessage: string
	readonly count: number
	readonly affectedServicesCount: number
	readonly lastSeen: string
}

export interface FindErrorsInput {
	readonly timeRange: TimeRange
	readonly service?: string
	readonly environment?: string
	/** "unexpected": only identities outside `namespacePrefix` plus the 5xx/unexpected-envelope markers. */
	readonly identity?: "unexpected"
	readonly namespacePrefix?: string
	readonly limit?: number
}

export interface LogEntry {
	readonly timestamp: string
	readonly severityText: string
	readonly serviceName: string
	readonly body: string
	readonly traceId: string
	readonly spanId: string
}

export interface SearchLogsInput {
	readonly timeRange: TimeRange
	readonly service?: string
	readonly severity?: string
	readonly search?: string
	readonly traceId?: string
	readonly spanId?: string
	readonly limit?: number
	readonly offset?: number
}

export interface SearchLogsOutput {
	readonly timeRange: TimeRange
	readonly total: number
	readonly logs: ReadonlyArray<LogEntry>
	readonly pagination: {
		readonly offset: number
		readonly limit: number
		readonly hasMore: boolean
	}
}

export interface MineLogPatternsInput {
	readonly timeRange: TimeRange
	readonly service?: string
	readonly severity?: string
	readonly search?: string
	readonly traceId?: string
	/** Maximum number of logs to sample for clustering. Defaults to 10000. */
	readonly sampleSize?: number
	/** How many top patterns to return. Defaults to 50. */
	readonly limit?: number
}

export interface LogPattern {
	readonly template: string
	readonly count: number
	readonly sample: string
	readonly severityCounts: Record<string, number>
	readonly serviceCounts: Record<string, number>
}

export interface MineLogPatternsOutput {
	readonly timeRange: TimeRange
	readonly sampleSize: number
	readonly totalSampled: number
	readonly patterns: ReadonlyArray<LogPattern>
}

export interface ServiceHealthOutput {
	readonly serviceName: string
	readonly timeRange: TimeRange
	readonly health: {
		readonly throughput: number
		readonly errorRate: number
		readonly errorCount: number
		readonly p50Ms: number
		readonly p95Ms: number
		readonly p99Ms: number
		readonly apdex: number
	}
	readonly topErrors: ReadonlyArray<{ fingerprintHash: string; label: string; count: number }>
	readonly recentTraces: ReadonlyArray<{
		traceId: string
		rootSpanName: string
		durationMs: number
		hasError: boolean
	}>
	readonly recentLogs: ReadonlyArray<LogEntry>
}

export interface ServiceEdge {
	readonly sourceService: string
	readonly targetService: string
	readonly callCount: number
	readonly errorCount: number
	readonly avgDurationMs: number
	/** Slowest call in the window, not a percentile. */
	readonly maxDurationMs: number
}

export interface FindSlowTracesInput {
	readonly timeRange: TimeRange
	readonly service?: string
	readonly environment?: string
	readonly limit?: number
}

export interface FindSlowTracesOutput {
	readonly timeRange: TimeRange
	readonly stats: {
		readonly p50Ms: number
		readonly p95Ms: number
		readonly minMs: number
		readonly maxMs: number
	} | null
	readonly traces: ReadonlyArray<SpanResult>
}

export interface ExploreAttributesInput {
	readonly source: "traces" | "metrics" | "services"
	readonly scope?: "span" | "resource"
	readonly key?: string
	readonly service?: string
	readonly timeRange: TimeRange
	readonly limit?: number
}

export interface AttributeKeyResult {
	readonly key: string
	readonly count: number
}

export interface AttributeValueResult {
	readonly value: string
	readonly count: number
}
