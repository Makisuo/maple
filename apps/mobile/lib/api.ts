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

export async function fetchTraces(startTime: string, endTime: string, opts?: { limit?: number }): Promise<Trace[]> {
  const res = await apiRequest<{
    result: { kind: string; data: Array<Record<string, unknown>> }
  }>("/api/query-engine/execute", {
    startTime,
    endTime,
    query: {
      kind: "list",
      source: "traces",
      limit: opts?.limit ?? 50,
      offset: 0,
      filters: {
        rootSpansOnly: true,
      },
    },
  })

  if (res.result.kind !== "list") return []

  return res.result.data.map(transformTraceRow)
}
