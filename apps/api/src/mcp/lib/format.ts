export function formatDurationMs(micros: number | bigint): string {
  const ms = Number(micros) / 1000
  if (ms < 1) return `${(Number(micros) / 1).toFixed(0)}us`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function formatDurationFromMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}us`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`
}

export function formatNumber(value: number | bigint): string {
  return Number(value).toLocaleString("en-US")
}

export function formatTable(
  headers: string[],
  rows: string[][],
): string {
  const headerLine = `| ${headers.join(" | ")} |`
  const sep = `|${headers.map(() => "---").join("|")}|`
  const dataLines = rows.map((row) => `| ${row.join(" | ")} |`)

  return [headerLine, sep, ...dataLines].join("\n")
}

export function truncate(str: string, maxLen = 80): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + "..."
}
