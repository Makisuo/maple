export interface TimeRange {
  readonly startTime: string
  readonly endTime: string
}

// --- Services ---

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

// --- Traces ---

export interface SpanResult {
  readonly traceId: string
  readonly spanId: string
  readonly spanName: string
  readonly serviceName: string
  readonly durationMs: number
  readonly statusCode: string
  readonly statusMessage: string
  readonly attributes: Record<string, string>
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
  readonly attributeFilters?: ReadonlyArray<{ key: string; value: string; mode?: string }>
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

// --- Inspect Trace ---

export interface SpanNode {
  readonly spanId: string
  readonly parentSpanId: string
  readonly spanName: string
  readonly serviceName: string
  readonly durationMs: number
  readonly statusCode: string
  readonly statusMessage: string
  readonly attributes: Record<string, string>
  readonly children: SpanNode[]
}

export interface InspectTraceOutput {
  readonly traceId: string
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

// --- Errors ---

export interface ErrorSummary {
  readonly errorType: string
  readonly count: number
  readonly affectedServicesCount: number
  readonly lastSeen: string
}

export interface FindErrorsInput {
  readonly timeRange: TimeRange
  readonly service?: string
  readonly environment?: string
  readonly limit?: number
}

// --- Logs ---

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

// --- Service Health ---

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
  readonly topErrors: ReadonlyArray<{ errorType: string; count: number }>
  readonly recentTraces: ReadonlyArray<{
    traceId: string
    rootSpanName: string
    durationMs: number
    hasError: boolean
  }>
  readonly recentLogs: ReadonlyArray<LogEntry>
}

// --- Service Map ---

export interface ServiceEdge {
  readonly sourceService: string
  readonly targetService: string
  readonly callCount: number
  readonly errorCount: number
  readonly avgDurationMs: number
  readonly p95DurationMs: number
}

// --- Slow Traces ---

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

// --- Attributes ---

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
