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

export const decodeAlertContextFromSearchParam = (raw: string): AlertContext | undefined => {
	try {
		const json = fromBase64Url(raw)
		const parsed = JSON.parse(json) as AlertContext
		if (!parsed || typeof parsed !== "object") return undefined
		return parsed
	} catch {
		return undefined
	}
}

export const alertTabId = (alert: AlertContext): string => `alert-${alert.incidentId ?? alert.ruleId}`

export const alertTabTitle = (alert: AlertContext): string => {
	const base = alert.ruleName.length > 28 ? `${alert.ruleName.slice(0, 28)}…` : alert.ruleName
	return base
}

export const signalLabel = (signalType: string): string => {
	switch (signalType) {
		case "error_rate":
			return "error rate"
		case "p95_latency":
			return "p95 latency"
		case "p99_latency":
			return "p99 latency"
		case "apdex":
			return "Apdex"
		case "throughput":
			return "throughput"
		case "metric":
			return "metric"
		default:
			return signalType
	}
}

const groupLabel = (alert: AlertContext): string => alert.groupKey ?? "the affected service"

export const alertPromptSuggestions = (alert: AlertContext): string[] => {
	const group = groupLabel(alert)
	const sig = alert.signalType
	const windowM = alert.windowMinutes

	if (alert.eventType === "test") return []

	if (alert.eventType === "resolve") {
		const base = [
			`Summarize what happened in ${group}`,
			`Timeline of traces, errors, and throughput during the incident`,
			`Root cause candidates for ${alert.ruleName}`,
		]
		if (sig.includes("latency")) base.push(`Which operations in ${group} recovered last?`)
		else if (sig === "error_rate") base.push(`Which exceptions drove the spike?`)
		return base
	}

	if (sig === "p95_latency" || sig === "p99_latency") {
		return [
			`Slowest operations in ${group} right now`,
			`Top 10 slowest traces in ${group}`,
			`Compare ${group} ${signalLabel(sig)} to the past week`,
			`Recent deploys or config changes in ${group}`,
		]
	}
	if (sig === "error_rate") {
		const newSince = Math.max(windowM * 12, 60)
		return [
			`Top exceptions in ${group} in the last ${windowM}m`,
			`New error types since ${newSince}m ago`,
			`Group errors in ${group} by endpoint`,
			`Sample stack traces per error class`,
		]
	}
	if (sig === "throughput") {
		return [
			`Plot ${group} throughput vs yesterday`,
			`Upstream callers of ${group} — any drops?`,
			`Operations in ${group} with biggest volume delta`,
		]
	}
	if (sig === "apdex") {
		return [
			`Is ${group} Apdex drop driven by latency or errors?`,
			`Slowest 20 traces in ${group} in the last ${windowM}m`,
			`Error rate vs latency correlation in ${group}`,
		]
	}
	if (sig === "metric") {
		return [
			`Raw metric values for ${group} last ${windowM}m`,
			`Compare this metric to the past week`,
			`Chart this metric for ${group} over 6h`,
		]
	}

	return [`Diagnose ${group}`, `Recent errors in ${group}`, `Slowest traces in ${group}`]
}
