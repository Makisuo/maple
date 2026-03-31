import { Console, Effect } from "effect"

export const printTable = (opts: {
  headers: string[]
  rows: string[][]
  title?: string
  summary?: string
}) =>
  Effect.gen(function* () {
    const { headers, rows, title, summary } = opts

    if (title) {
      yield* Console.log(`\n${title}`)
      yield* Console.log("─".repeat(Math.min(title.length + 4, 80)))
    }

    if (rows.length === 0) {
      yield* Console.log("  (no results)")
      return
    }

    // Calculate column widths
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
    )

    // Header
    const headerLine = headers.map((h, i) => h.padEnd(widths[i]!)).join("  ")
    yield* Console.log(`  ${headerLine}`)
    yield* Console.log(`  ${widths.map((w) => "─".repeat(w)).join("  ")}`)

    // Rows
    for (const row of rows) {
      const line = row.map((cell, i) => (cell ?? "").padEnd(widths[i]!)).join("  ")
      yield* Console.log(`  ${line}`)
    }

    if (summary) {
      yield* Console.log(`\n  ${summary}`)
    }
  })

export const printJson = (data: unknown) =>
  Console.log(JSON.stringify(data, null, 2))

export const formatDurationMs = (microsOrMs: number, isMicros = true): string => {
  const ms = isMicros ? microsOrMs / 1000 : microsOrMs
  if (ms < 1) return `${ms.toFixed(2)}ms`
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

export const formatPercent = (value: number): string =>
  `${value.toFixed(2)}%`

export const formatNumber = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

export const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 3) + "..."
