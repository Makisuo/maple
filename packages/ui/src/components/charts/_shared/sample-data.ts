export const defaultBarData = [
  { name: "Jan", value: 186 },
  { name: "Feb", value: 305 },
  { name: "Mar", value: 237 },
  { name: "Apr", value: 173 },
  { name: "May", value: 209 },
  { name: "Jun", value: 214 },
]

export const multiBarData = [
  { name: "Jan", desktop: 186, mobile: 80 },
  { name: "Feb", desktop: 305, mobile: 200 },
  { name: "Mar", desktop: 237, mobile: 120 },
  { name: "Apr", desktop: 173, mobile: 190 },
  { name: "May", desktop: 209, mobile: 130 },
  { name: "Jun", desktop: 214, mobile: 140 },
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

export const multiLineData = [
  { date: "Jan", desktop: 186, mobile: 80 },
  { date: "Feb", desktop: 305, mobile: 200 },
  { date: "Mar", desktop: 237, mobile: 120 },
  { date: "Apr", desktop: 73, mobile: 190 },
  { date: "May", desktop: 209, mobile: 130 },
  { date: "Jun", desktop: 214, mobile: 140 },
]

export const partialLineData = [
  { date: "Jan", value: 186, forecast: false },
  { date: "Feb", value: 305, forecast: false },
  { date: "Mar", value: 237, forecast: false },
  { date: "Apr", value: 173, forecast: true },
  { date: "May", value: 209, forecast: true },
  { date: "Jun", value: 244, forecast: true },
]

export const pieData = [
  { name: "Chrome", value: 275, fill: "var(--color-chrome)" },
  { name: "Safari", value: 200, fill: "var(--color-safari)" },
  { name: "Firefox", value: 187, fill: "var(--color-firefox)" },
  { name: "Edge", value: 173, fill: "var(--color-edge)" },
  { name: "Other", value: 90, fill: "var(--color-other)" },
]

export const radialData = [
  { name: "Chrome", value: 275, fill: "var(--color-chrome)" },
  { name: "Safari", value: 200, fill: "var(--color-safari)" },
  { name: "Firefox", value: 187, fill: "var(--color-firefox)" },
  { name: "Edge", value: 173, fill: "var(--color-edge)" },
]

export const radarData = [
  { subject: "Math", a: 120, b: 110 },
  { subject: "Chinese", a: 98, b: 130 },
  { subject: "English", a: 86, b: 130 },
  { subject: "Geography", a: 99, b: 100 },
  { subject: "Physics", a: 85, b: 90 },
  { subject: "History", a: 65, b: 85 },
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
  { bucket: "2024-01-01T00:00:00Z", throughput: 1240 },
  { bucket: "2024-01-01T01:00:00Z", throughput: 1580 },
  { bucket: "2024-01-01T02:00:00Z", throughput: 980 },
  { bucket: "2024-01-01T03:00:00Z", throughput: 1720 },
  { bucket: "2024-01-01T04:00:00Z", throughput: 1350 },
  { bucket: "2024-01-01T05:00:00Z", throughput: 1100 },
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
