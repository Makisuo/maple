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
