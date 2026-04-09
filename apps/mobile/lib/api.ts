const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:3472"

let getToken: (() => Promise<string | null>) | undefined

export function setAuthTokenProvider(provider: () => Promise<string | null>) {
  getToken = provider
}

async function apiRequest<T>(path: string, body: unknown): Promise<T> {
  const token = getToken ? await getToken() : null
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers.authorization = `Bearer ${token}`

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`API ${path} failed: ${res.status}`)
  }

  return res.json()
}

// ── Queries ──

export interface ServiceUsage {
  serviceName: string
  totalLogs: number
  totalTraces: number
  totalMetrics: number
  dataSizeBytes: number
}

export async function fetchServiceUsage(startTime: string, endTime: string): Promise<ServiceUsage[]> {
  const res = await apiRequest<{ data: Array<Record<string, unknown>> }>(
    "/api/query-engine/service-usage",
    { startTime, endTime },
  )

  return (res.data ?? []).map((row) => ({
    serviceName: String(row.serviceName ?? ""),
    totalLogs: Number(row.totalLogCount ?? 0),
    totalTraces: Number(row.totalTraceCount ?? 0),
    totalMetrics:
      Number(row.totalSumMetricCount ?? 0) +
      Number(row.totalGaugeMetricCount ?? 0) +
      Number(row.totalHistogramMetricCount ?? 0) +
      Number(row.totalExpHistogramMetricCount ?? 0),
    dataSizeBytes: Number(row.totalSizeBytes ?? 0),
  }))
}

export interface TimeSeriesPoint {
  bucket: string
  throughput: number
  errorRate: number
  p50LatencyMs: number
  p95LatencyMs: number
  p99LatencyMs: number
}

export async function fetchOverviewTimeSeries(
  startTime: string,
  endTime: string,
  bucketSeconds: number,
): Promise<TimeSeriesPoint[]> {
  const res = await apiRequest<{
    result: { kind: string; data: Array<{ bucket: string; series: Record<string, number> }> }
  }>("/api/query-engine/execute", {
    startTime,
    endTime,
    query: {
      kind: "timeseries",
      source: "traces",
      metric: "count",
      allMetrics: true,
      filters: { rootSpansOnly: true },
      bucketSeconds,
    },
  })

  if (res.result.kind !== "timeseries") return []

  return res.result.data.map((p) => ({
    bucket: p.bucket,
    throughput: p.series.count ?? 0,
    errorRate: p.series.error_rate ?? 0,
    p50LatencyMs: p.series.p50_duration ?? 0,
    p95LatencyMs: p.series.p95_duration ?? 0,
    p99LatencyMs: p.series.p99_duration ?? 0,
  }))
}

export interface LogsTimeSeriesPoint {
  bucket: string
  count: number
}

export async function fetchLogsTimeSeries(
  startTime: string,
  endTime: string,
  bucketSeconds: number,
): Promise<LogsTimeSeriesPoint[]> {
  const res = await apiRequest<{
    result: { kind: string; data: Array<{ bucket: string; series: Record<string, number> }> }
  }>("/api/query-engine/execute", {
    startTime,
    endTime,
    query: {
      kind: "timeseries",
      source: "logs",
      metric: "count",
      bucketSeconds,
    },
  })

  if (res.result.kind !== "timeseries") return []

  return res.result.data.map((p) => ({
    bucket: p.bucket,
    count: p.series.all ?? p.series.count ?? 0,
  }))
}

// ── Services ──

export interface ServiceOverview {
  serviceName: string
  environment: string
  p50LatencyMs: number
  p95LatencyMs: number
  p99LatencyMs: number
  errorRate: number // percentage 0-100
  throughput: number // req/s
}

export async function fetchServiceOverview(startTime: string, endTime: string): Promise<ServiceOverview[]> {
  const res = await apiRequest<{ data: Array<Record<string, unknown>> }>(
    "/api/query-engine/service-overview",
    { startTime, endTime },
  )

  const startMs = new Date(startTime.replace(" ", "T") + "Z").getTime()
  const endMs = new Date(endTime.replace(" ", "T") + "Z").getTime()
  const durationSeconds = Math.max((endMs - startMs) / 1000, 1)

  // Group raw rows by service+environment and aggregate
  const groups = new Map<string, Array<{
    spanCount: number
    errorCount: number
    p50LatencyMs: number
    p95LatencyMs: number
    p99LatencyMs: number
    serviceName: string
    environment: string
  }>>()

  for (const raw of res.data ?? []) {
    const serviceName = String(raw.serviceName ?? "")
    const environment = String(raw.environment ?? "unknown")
    const key = `${serviceName}::${environment}`

    const row = {
      serviceName,
      environment,
      spanCount: Number(raw.spanCount ?? 0),
      errorCount: Number(raw.errorCount ?? 0),
      p50LatencyMs: Number(raw.p50LatencyMs ?? 0),
      p95LatencyMs: Number(raw.p95LatencyMs ?? 0),
      p99LatencyMs: Number(raw.p99LatencyMs ?? 0),
    }

    const group = groups.get(key)
    if (group) {
      group.push(row)
    } else {
      groups.set(key, [row])
    }
  }

  const results: ServiceOverview[] = []

  for (const group of groups.values()) {
    const totalSpans = group.reduce((sum, r) => sum + r.spanCount, 0)
    const totalErrors = group.reduce((sum, r) => sum + r.errorCount, 0)

    let p50 = 0
    let p95 = 0
    let p99 = 0
    if (totalSpans > 0) {
      for (const r of group) {
        const weight = r.spanCount / totalSpans
        p50 += r.p50LatencyMs * weight
        p95 += r.p95LatencyMs * weight
        p99 += r.p99LatencyMs * weight
      }
    }

    results.push({
      serviceName: group[0].serviceName,
      environment: group[0].environment,
      p50LatencyMs: p50,
      p95LatencyMs: p95,
      p99LatencyMs: p99,
      errorRate: totalSpans > 0 ? (totalErrors / totalSpans) * 100 : 0,
      throughput: totalSpans / durationSeconds,
    })
  }

  results.sort((a, b) => b.throughput - a.throughput)
  return results
}

/** Fetch per-service error rate timeseries for sparklines. Returns a map of serviceName → error rate values. */
export async function fetchServiceSparklines(
  startTime: string,
  endTime: string,
  bucketSeconds: number,
): Promise<Record<string, number[]>> {
  const res = await apiRequest<{
    result: { kind: string; data: Array<{ bucket: string; series: Record<string, number> }> }
  }>("/api/query-engine/execute", {
    startTime,
    endTime,
    query: {
      kind: "timeseries",
      source: "traces",
      metric: "error_rate",
      filters: { rootSpansOnly: true },
      groupBy: ["service"],
      bucketSeconds,
    },
  })

  if (res.result.kind !== "timeseries") return {}

  // series keys are service names, values are error rates per bucket
  const byService: Record<string, number[]> = {}
  for (const point of res.result.data) {
    for (const [service, value] of Object.entries(point.series)) {
      if (!byService[service]) byService[service] = []
      byService[service].push(value)
    }
  }
  return byService
}

// ── Service Detail ──

export interface ServiceDetailPoint {
  bucket: string
  throughput: number
  errorRate: number
  p50LatencyMs: number
  p95LatencyMs: number
  p99LatencyMs: number
}

export async function fetchServiceDetailTimeSeries(
  serviceName: string,
  startTime: string,
  endTime: string,
  bucketSeconds: number,
): Promise<ServiceDetailPoint[]> {
  const res = await apiRequest<{
    result: { kind: string; data: Array<{ bucket: string; series: Record<string, number> }> }
  }>("/api/query-engine/execute", {
    startTime,
    endTime,
    query: {
      kind: "timeseries",
      source: "traces",
      metric: "count",
      allMetrics: true,
      filters: { rootSpansOnly: true, serviceName },
      bucketSeconds,
    },
  })

  if (res.result.kind !== "timeseries") return []

  return res.result.data.map((p) => ({
    bucket: p.bucket,
    throughput: p.series.count ?? 0,
    errorRate: p.series.error_rate ?? 0,
    p50LatencyMs: p.series.p50_duration ?? 0,
    p95LatencyMs: p.series.p95_duration ?? 0,
    p99LatencyMs: p.series.p99_duration ?? 0,
  }))
}

export interface ApdexPoint {
  bucket: string
  apdexScore: number
  totalCount: number
}

export async function fetchServiceApdex(
  serviceName: string,
  startTime: string,
  endTime: string,
  bucketSeconds: number,
): Promise<ApdexPoint[]> {
  const res = await apiRequest<{ data: Array<Record<string, unknown>> }>(
    "/api/query-engine/service-apdex",
    { serviceName, startTime, endTime, bucketSeconds },
  )

  return (res.data ?? []).map((row) => ({
    bucket: String(row.bucket ?? ""),
    apdexScore: Number(row.apdexScore ?? 0),
    totalCount: Number(row.totalCount ?? 0),
  }))
}

// ── Traces ──

export interface HttpInfo {
  method: string
  route: string | null
  statusCode: number | null
  isError: boolean
}

export interface Trace {
  traceId: string
  startTime: string
  durationMs: number
  spanCount: number
  services: string[]
  rootSpanName: string
  hasError: boolean
  http: HttpInfo | null
  statusCode: string
}

function getHttpInfo(spanName: string, attrs: Record<string, string>): HttpInfo | null {
  const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const
  let method = attrs["http.method"] || attrs["http.request.method"]
  let route: string | null = attrs["http.route"] || attrs["http.target"] || attrs["url.path"] || null

  if (!method) {
    const parts = spanName.split(" ")
    if (spanName.startsWith("http.server ") && parts.length >= 2) {
      method = parts[1]
      if (!route && parts.length >= 3) route = parts.slice(2).join(" ")
    } else if (parts.length >= 2 && HTTP_METHODS.includes(parts[0].toUpperCase() as (typeof HTTP_METHODS)[number])) {
      method = parts[0].toUpperCase()
      if (!route) route = parts.slice(1).join(" ")
    } else if (HTTP_METHODS.includes(spanName.toUpperCase() as (typeof HTTP_METHODS)[number])) {
      method = spanName.toUpperCase()
    }
  }

  if (!method) return null

  const rawStatus = attrs["http.status_code"] || attrs["http.response.status_code"]
  const statusCode = rawStatus ? parseInt(rawStatus, 10) || null : null

  return {
    method: method.toUpperCase(),
    route,
    statusCode,
    isError: statusCode != null && statusCode >= 500,
  }
}

function transformTraceRow(row: Record<string, unknown>): Trace {
  const spanAttrs = (row.spanAttributes ?? {}) as Record<string, string>
  const httpAttrs: Record<string, string> = {}
  for (const key of [
    "http.method", "http.route", "http.status_code", "http.request.method",
    "url.path", "http.response.status_code", "http.target",
  ]) {
    if (spanAttrs[key]) httpAttrs[key] = spanAttrs[key]
  }

  return {
    traceId: String(row.traceId),
    startTime: String(row.timestamp),
    durationMs: Number(row.durationMs),
    spanCount: 1,
    services: [String(row.serviceName)],
    rootSpanName: String(row.spanName),
    hasError: row.hasError === true || row.hasError === 1,
    http: getHttpInfo(String(row.spanName), httpAttrs),
    statusCode: String(row.statusCode),
  }
}

export interface TraceFilters {
  serviceName?: string
  spanName?: string
  errorsOnly?: boolean
}

export async function fetchTraces(
  startTime: string,
  endTime: string,
  opts?: { limit?: number; offset?: number; filters?: TraceFilters },
): Promise<Trace[]> {
  const f = opts?.filters
  const matchModes: Record<string, string> = {}
  if (f?.serviceName) matchModes.serviceName = "contains"
  if (f?.spanName) matchModes.spanName = "contains"

  const res = await apiRequest<{
    result: { kind: string; data: Array<Record<string, unknown>> }
  }>("/api/query-engine/execute", {
    startTime,
    endTime,
    query: {
      kind: "list",
      source: "traces",
      limit: opts?.limit ?? 50,
      offset: opts?.offset ?? 0,
      filters: {
        rootSpansOnly: true,
        serviceName: f?.serviceName,
        spanName: f?.spanName,
        errorsOnly: f?.errorsOnly,
        matchModes: Object.keys(matchModes).length > 0 ? matchModes : undefined,
      },
    },
  })

  if (res.result.kind !== "list") return []

  return res.result.data.map(transformTraceRow)
}

export interface TracesFacets {
  services: Array<{ name: string; count: number }>
  spanNames: Array<{ name: string; count: number }>
}

export async function fetchTracesFacets(startTime: string, endTime: string): Promise<TracesFacets> {
  const res = await apiRequest<{
    result: { kind: string; data: Array<Record<string, unknown>> }
  }>("/api/query-engine/execute", {
    startTime,
    endTime,
    query: {
      kind: "facets",
      source: "traces",
      filters: { rootSpansOnly: true },
    },
  })

  if (res.result.kind !== "facets") return { services: [], spanNames: [] }

  const toItem = (row: Record<string, unknown>) => ({
    name: String(row.name ?? ""),
    count: Number(row.count ?? 0),
  })
  const byType = (type: string) =>
    res.result.data.filter((r) => String(r.facetType) === type).map(toItem)

  return {
    services: byType("service"),
    spanNames: byType("spanName"),
  }
}

// ── Logs ──

export interface Log {
  timestamp: string
  severityText: string
  severityNumber: number
  serviceName: string
  body: string
  traceId: string
  spanId: string
  logAttributes: Record<string, string>
  resourceAttributes: Record<string, string>
}

export interface LogsPage {
  data: Log[]
  cursor: string | null
}

function parseAttributes(value: unknown): Record<string, string> {
  if (!value || typeof value !== "string") return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function transformLogRow(row: Record<string, unknown>): Log {
  return {
    timestamp: String(row.timestamp ?? ""),
    severityText: String(row.severityText ?? ""),
    severityNumber: Number(row.severityNumber ?? 0),
    serviceName: String(row.serviceName ?? ""),
    body: String(row.body ?? ""),
    traceId: String(row.traceId ?? ""),
    spanId: String(row.spanId ?? ""),
    logAttributes: parseAttributes(row.logAttributes),
    resourceAttributes: parseAttributes(row.resourceAttributes),
  }
}

export interface LogsFilters {
  service?: string
  severity?: string
  search?: string
}

export async function fetchLogs(
  startTime: string,
  endTime: string,
  opts?: { limit?: number; cursor?: string; filters?: LogsFilters },
): Promise<LogsPage> {
  const limit = opts?.limit ?? 50
  const f = opts?.filters

  const res = await apiRequest<{ data: Array<Record<string, unknown>> }>(
    "/api/query-engine/list-logs",
    {
      startTime,
      endTime,
      limit,
      cursor: opts?.cursor,
      service: f?.service,
      severity: f?.severity,
      search: f?.search,
    },
  )

  const logs = (res.data ?? []).map(transformLogRow)
  const cursor = logs.length === limit && logs.length > 0 ? logs[logs.length - 1].timestamp : null

  return { data: logs, cursor }
}
