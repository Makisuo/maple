import { Tinybird } from "@tinybirdco/sdk"
import {
  errorsSummary,
  errorsByType,
  serviceOverview,
  serviceApdexTimeSeries,
  errorDetailTraces,
  spanHierarchy,
  listLogs,
} from "@maple/domain/tinybird"
import { getConfig } from "./config"

let _client: ReturnType<typeof createClient> | null = null

function createClient() {
  const config = getConfig()
  return new Tinybird({
    baseUrl: config.TINYBIRD_HOST,
    token: config.TINYBIRD_TOKEN,
    datasources: {},
    pipes: {
      errors_summary: errorsSummary,
      errors_by_type: errorsByType,
      service_overview: serviceOverview,
      service_apdex_time_series: serviceApdexTimeSeries,
      error_detail_traces: errorDetailTraces,
      span_hierarchy: spanHierarchy,
      list_logs: listLogs,
    },
  })
}

function getClient() {
  if (!_client) _client = createClient()
  return _client
}

export function formatForTinybird(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19)
}

// --- Typed query helpers ---

export interface ErrorsSummaryRow {
  errorRate: number
  totalErrors: number
  affectedServicesCount: number
}

export async function fetchErrorsSummary(
  orgId: string,
  startTime: string,
  endTime: string,
): Promise<ErrorsSummaryRow | null> {
  const result = await getClient().errors_summary.query({
    start_time: startTime,
    end_time: endTime,
    org_id: orgId,
  })
  return (result.data[0] as ErrorsSummaryRow) ?? null
}

export interface ErrorByTypeRow {
  errorType: string
  count: number
  affectedServices: string[]
}

export async function fetchErrorsByType(
  orgId: string,
  startTime: string,
  endTime: string,
): Promise<ErrorByTypeRow[]> {
  const result = await getClient().errors_by_type.query({
    start_time: startTime,
    end_time: endTime,
    org_id: orgId,
  })
  return result.data as ErrorByTypeRow[]
}

export interface ServiceOverviewRow {
  serviceName: string
  p99LatencyMs: number
  errorRate: number
  throughput: number
}

export async function fetchServiceOverview(
  orgId: string,
  startTime: string,
  endTime: string,
): Promise<ServiceOverviewRow[]> {
  const result = await getClient().service_overview.query({
    start_time: startTime,
    end_time: endTime,
    org_id: orgId,
  })
  return result.data.map((row) => ({
    serviceName: row.serviceName,
    p99LatencyMs: Number(row.p99LatencyMs),
    errorRate: Number(row.spanCount) > 0
      ? Math.round((Number(row.errorCount) / Number(row.spanCount)) * 10000) / 100
      : 0,
    throughput: Number(row.throughput),
  }))
}

export interface ApdexRow {
  apdexScore: number
  totalCount: number
}

export async function fetchServiceApdex(
  orgId: string,
  serviceName: string,
  startTime: string,
  endTime: string,
  bucketSeconds: number,
): Promise<ApdexRow[]> {
  const result = await getClient().service_apdex_time_series.query({
    service_name: serviceName,
    start_time: startTime,
    end_time: endTime,
    bucket_seconds: bucketSeconds,
    org_id: orgId,
  })
  return result.data as ApdexRow[]
}

export interface ErrorTraceRow {
  traceId: string
  rootSpanName: string
  durationMs: number
  serviceName: string
  statusCode: string
}

export async function fetchErrorTraces(
  orgId: string,
  errorType: string,
  startTime: string,
  endTime: string,
  limit = 5,
): Promise<ErrorTraceRow[]> {
  const result = await getClient().error_detail_traces.query({
    error_type: errorType,
    start_time: startTime,
    end_time: endTime,
    limit,
    org_id: orgId,
  })
  return result.data.map((row) => ({
    traceId: row.traceId,
    rootSpanName: row.rootSpanName,
    durationMs: Number(row.durationMicros) / 1000,
    serviceName: row.services[0] ?? "unknown",
    statusCode: "Error",
  }))
}

export interface SpanHierarchyRow {
  traceId: string
  spanId: string
  parentSpanId: string
  spanName: string
  serviceName: string
  durationMs: number
  statusCode: string
}

export async function fetchSpanHierarchy(
  orgId: string,
  traceId: string,
): Promise<SpanHierarchyRow[]> {
  const result = await getClient().span_hierarchy.query({
    trace_id: traceId,
    org_id: orgId,
  })
  return result.data as SpanHierarchyRow[]
}

export interface LogRow {
  timestamp: string
  severity: string
  body: string
  serviceName: string
  traceId: string
  spanId: string
}

export async function searchLogs(
  orgId: string,
  params: {
    traceId?: string
    serviceName?: string
    startTime?: string
    endTime?: string
    limit?: number
  },
): Promise<LogRow[]> {
  const queryParams: Record<string, unknown> = { org_id: orgId }
  if (params.traceId) queryParams.trace_id = params.traceId
  if (params.serviceName) queryParams.service = params.serviceName
  if (params.startTime) queryParams.start_time = params.startTime
  if (params.endTime) queryParams.end_time = params.endTime
  if (params.limit) queryParams.limit = params.limit

  const result = await getClient().list_logs.query(queryParams)
  return result.data.map((row) => ({
    timestamp: String(row.timestamp),
    severity: row.severityText,
    body: row.body,
    serviceName: row.serviceName,
    traceId: row.traceId,
    spanId: row.spanId,
  }))
}
