export interface AlertContext {
  ruleId: string
  ruleName: string
  incidentId: string | null
  eventType: string
  signalType: string
  severity: string
  comparator: string
  threshold: number
  value: number | null
  windowMinutes: number
  groupKey: string | null
  sampleCount: number | null
}

const fromBase64Url = (input: string): string => {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/")
  const pad = padded.length % 4
  const full = pad === 0 ? padded : padded + "=".repeat(4 - pad)
  if (typeof atob !== "undefined") {
    try {
      return decodeURIComponent(escape(atob(full)))
    } catch {
      return atob(full)
    }
  }
  return Buffer.from(full, "base64").toString("utf8")
}

export const decodeAlertContextFromSearchParam = (
  raw: string,
): AlertContext | undefined => {
  try {
    const json = fromBase64Url(raw)
    const parsed = JSON.parse(json) as AlertContext
    if (!parsed || typeof parsed !== "object") return undefined
    return parsed
  } catch {
    return undefined
  }
}

export const alertTabId = (alert: AlertContext): string =>
  `alert-${alert.incidentId ?? alert.ruleId}`

export const alertTabTitle = (alert: AlertContext): string => {
  const base = alert.ruleName.length > 28 ? `${alert.ruleName.slice(0, 28)}…` : alert.ruleName
  return base
}

export const alertPromptSuggestions = (alert: AlertContext): string[] => {
  const group = alert.groupKey ?? "the affected service"
  const suggestions = [
    "Why did this alert fire?",
    `Show recent errors in ${group}`,
    "What changed in the last 24 hours?",
  ]
  if (alert.signalType.includes("latency")) {
    suggestions.push(`Find the slowest traces in ${group}`)
  } else if (alert.signalType === "error_rate") {
    suggestions.push(`Group errors by endpoint in ${group}`)
  } else if (alert.signalType === "throughput") {
    suggestions.push(`Compare throughput to last week in ${group}`)
  } else {
    suggestions.push(`Diagnose ${group}`)
  }
  return suggestions
}
