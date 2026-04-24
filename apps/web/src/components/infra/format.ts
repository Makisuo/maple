export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "—"
  const pct = fraction * 100
  if (pct < 0.05) return "0%"
  if (pct < 10) return `${pct.toFixed(1)}%`
  return `${pct.toFixed(0)}%`
}

export function formatLoad(load: number): string {
  if (!Number.isFinite(load)) return "—"
  return load.toFixed(2)
}

export function formatBytesPerSecond(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes === 0) return "0 B/s"
  const units = ["B/s", "KB/s", "MB/s", "GB/s"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

// ClickHouse serializes DateTime as `YYYY-MM-DD HH:MM:SS[.fraction]` with no
// timezone suffix. `new Date(...)` on that string parses as *local* time in
// Chrome, which skews by the browser's UTC offset (e.g. "2h ago" for a row
// actually written seconds ago in CEST). Normalize to a UTC ISO string
// before handing it to `new Date`. Real ISO strings with Z / offset pass
// through unchanged.
const normalizeToUtcIso = (input: string): string => {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(input)) return input
  return input.includes("T") ? `${input}Z` : `${input.replace(" ", "T")}Z`
}

export function formatRelative(iso: string): string {
  const then = new Date(normalizeToUtcIso(iso)).getTime()
  if (!Number.isFinite(then)) return "—"
  const diffMs = Date.now() - then
  if (diffMs < 0) return "just now"
  const s = Math.floor(diffMs / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export type HostStatus = "active" | "idle" | "down"
export type SeverityLevel = "ok" | "warn" | "crit"

export function severityLevel(fraction: number): SeverityLevel {
  if (!Number.isFinite(fraction)) return "ok"
  if (fraction >= 0.9) return "crit"
  if (fraction >= 0.6) return "warn"
  return "ok"
}

const SCRAPE_INTERVAL_MS = 30_000

export function deriveHostStatus(lastSeenIso: string, now = Date.now()): HostStatus {
  const lastSeen = new Date(normalizeToUtcIso(lastSeenIso)).getTime()
  if (!Number.isFinite(lastSeen)) return "down"
  const age = now - lastSeen
  if (age < SCRAPE_INTERVAL_MS * 2) return "active"
  if (age < SCRAPE_INTERVAL_MS * 10) return "idle"
  return "down"
}
