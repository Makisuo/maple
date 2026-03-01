import type { HttpEndpointOverview } from "@/api/tinybird/endpoints-overview"

function formatLatency(ms: number): string {
  if (ms == null || Number.isNaN(ms)) return "-"
  if (ms < 1) return `${(ms * 1000).toFixed(0)}us`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}

function formatRate(rate: number): string {
  if (rate < 0.01) return "0%"
  if (rate < 1) return `${rate.toFixed(2)}%`
  return `${rate.toFixed(1)}%`
}

function formatThroughput(count: number, durationSeconds: number): string {
  if (durationSeconds <= 0) return `${count}`
  const rate = count / durationSeconds
  if (rate >= 1000) return `${(rate / 1000).toFixed(1)}k/s`
  if (rate >= 1) return `${rate.toFixed(1)}/s`
  if (rate >= 0.01) return `${rate.toFixed(2)}/s`
  return `${rate.toFixed(3)}/s`
}

interface StatCardProps {
  label: string
  value: string
}

function StatCard({ label, value }: StatCardProps) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight font-mono">{value}</p>
    </div>
  )
}

interface EndpointSummaryStatsProps {
  endpoint: HttpEndpointOverview | undefined
  durationSeconds: number
}

export function EndpointSummaryStats({ endpoint, durationSeconds }: EndpointSummaryStatsProps) {
  if (!endpoint) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-lg border bg-card p-4">
            <div className="h-4 w-16 rounded bg-muted animate-pulse" />
            <div className="mt-2 h-7 w-20 rounded bg-muted animate-pulse" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard label="Total Requests" value={formatNumber(endpoint.count)} />
      <StatCard label="Avg Latency" value={formatLatency(endpoint.avgDuration)} />
      <StatCard label="P95 Latency" value={formatLatency(endpoint.p95Duration)} />
      <StatCard label="P99 Latency" value={formatLatency(endpoint.p99Duration)} />
      <StatCard label="Error Rate" value={formatRate(endpoint.errorRate)} />
      <StatCard label="Throughput" value={formatThroughput(endpoint.count, durationSeconds)} />
    </div>
  )
}
