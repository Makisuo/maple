export const defaultBarData = [
  { name: "Jan", value: 186 },
  { name: "Feb", value: 305 },
  { name: "Mar", value: 237 },
  { name: "Apr", value: 173 },
  { name: "May", value: 209 },
  { name: "Jun", value: 214 },
]

export const areaTimeSeriesData = [
  { month: "Jan", desktop: 186, mobile: 80 },
  { month: "Feb", desktop: 305, mobile: 200 },
  { month: "Mar", desktop: 237, mobile: 120 },
  { month: "Apr", desktop: 73, mobile: 190 },
  { month: "May", desktop: 209, mobile: 130 },
  { month: "Jun", desktop: 214, mobile: 140 },
]

export const lineTimeSeriesData = [
  { date: "Jan", value: 186 },
  { date: "Feb", value: 305 },
  { date: "Mar", value: 237 },
  { date: "Apr", value: 73 },
  { date: "May", value: 209 },
  { date: "Jun", value: 214 },
]

export const latencyTimeSeriesData = [
  { bucket: "2024-01-01T00:00:00Z", p50LatencyMs: 12, p95LatencyMs: 45, p99LatencyMs: 120 },
  { bucket: "2024-01-01T01:00:00Z", p50LatencyMs: 15, p95LatencyMs: 52, p99LatencyMs: 135 },
  { bucket: "2024-01-01T02:00:00Z", p50LatencyMs: 11, p95LatencyMs: 40, p99LatencyMs: 98 },
  { bucket: "2024-01-01T03:00:00Z", p50LatencyMs: 18, p95LatencyMs: 61, p99LatencyMs: 155 },
  { bucket: "2024-01-01T04:00:00Z", p50LatencyMs: 14, p95LatencyMs: 48, p99LatencyMs: 110 },
  { bucket: "2024-01-01T05:00:00Z", p50LatencyMs: 13, p95LatencyMs: 44, p99LatencyMs: 102 },
]

export const throughputTimeSeriesData = [
  { bucket: "2024-01-01T00:00:00Z", throughput: 1240, errorRate: 1.2 },
  { bucket: "2024-01-01T01:00:00Z", throughput: 1580, errorRate: 2.5 },
  { bucket: "2024-01-01T02:00:00Z", throughput: 980, errorRate: 0.8 },
  { bucket: "2024-01-01T03:00:00Z", throughput: 1720, errorRate: 4.2 },
  { bucket: "2024-01-01T04:00:00Z", throughput: 1350, errorRate: 1.8 },
  { bucket: "2024-01-01T05:00:00Z", throughput: 1100, errorRate: 1.1 },
]

export const apdexTimeSeriesData = [
  { bucket: "2024-01-01T00:00:00Z", apdexScore: 0.94 },
  { bucket: "2024-01-01T01:00:00Z", apdexScore: 0.91 },
  { bucket: "2024-01-01T02:00:00Z", apdexScore: 0.96 },
  { bucket: "2024-01-01T03:00:00Z", apdexScore: 0.88 },
  { bucket: "2024-01-01T04:00:00Z", apdexScore: 0.92 },
  { bucket: "2024-01-01T05:00:00Z", apdexScore: 0.95 },
]

export const errorRateTimeSeriesData = [
  { bucket: "2024-01-01T00:00:00Z", errorRate: 0.012 },
  { bucket: "2024-01-01T01:00:00Z", errorRate: 0.025 },
  { bucket: "2024-01-01T02:00:00Z", errorRate: 0.008 },
  { bucket: "2024-01-01T03:00:00Z", errorRate: 0.042 },
  { bucket: "2024-01-01T04:00:00Z", errorRate: 0.018 },
  { bucket: "2024-01-01T05:00:00Z", errorRate: 0.011 },
]
