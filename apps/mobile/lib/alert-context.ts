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

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function base64Decode(input: string): string {
	const padded = input.replace(/-/g, "+").replace(/_/g, "/")
	const pad = padded.length % 4
	const full = pad === 0 ? padded : padded + "=".repeat(4 - pad)

	const bytes: number[] = []
	for (let i = 0; i < full.length; i += 4) {
		const c1 = BASE64_CHARS.indexOf(full[i])
		const c2 = BASE64_CHARS.indexOf(full[i + 1])
		const c3 = full[i + 2] === "=" ? 0 : BASE64_CHARS.indexOf(full[i + 2])
		const c4 = full[i + 3] === "=" ? 0 : BASE64_CHARS.indexOf(full[i + 3])

		bytes.push((c1 << 2) | (c2 >> 4))
		if (full[i + 2] !== "=") bytes.push(((c2 & 15) << 4) | (c3 >> 2))
		if (full[i + 3] !== "=") bytes.push(((c3 & 3) << 6) | c4)
	}

	let str = ""
	let i = 0
	while (i < bytes.length) {
		const b1 = bytes[i]
		if (b1 < 0x80) {
			str += String.fromCharCode(b1)
			i += 1
		} else if (b1 < 0xe0) {
			str += String.fromCharCode(((b1 & 0x1f) << 6) | (bytes[i + 1] & 0x3f))
			i += 2
		} else if (b1 < 0xf0) {
			str += String.fromCharCode(
				((b1 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f),
			)
			i += 3
		} else {
			const cp =
				((b1 & 0x07) << 18) |
				((bytes[i + 1] & 0x3f) << 12) |
				((bytes[i + 2] & 0x3f) << 6) |
				(bytes[i + 3] & 0x3f)
			const off = cp - 0x10000
			str += String.fromCharCode(0xd800 + (off >> 10), 0xdc00 + (off & 0x3ff))
			i += 4
		}
	}
	return str
}

export function decodeAlertContextFromSearchParam(raw: string): AlertContext | undefined {
	try {
		const json = base64Decode(raw)
		const parsed = JSON.parse(json) as AlertContext
		if (!parsed || typeof parsed !== "object") return undefined
		return parsed
	} catch {
		return undefined
	}
}

export function alertThreadId(alert: AlertContext): string {
	return `alert-${alert.incidentId ?? alert.ruleId}`
}

export function alertTitle(alert: AlertContext): string {
	const base = alert.ruleName.length > 28 ? `${alert.ruleName.slice(0, 28)}…` : alert.ruleName
	return base
}

export function signalLabel(signalType: string): string {
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

function groupLabel(alert: AlertContext): string {
	return alert.groupKey ?? "the affected service"
}

export function alertPromptSuggestions(alert: AlertContext): string[] {
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

export function severityColor(severity: string): string {
	switch (severity.toLowerCase()) {
		case "critical":
		case "fatal":
			return "#a03a20"
		case "error":
		case "high":
			return "#c45a3c"
		case "warning":
		case "warn":
		case "medium":
			return "#c89b48"
		case "info":
		case "low":
			return "#5cb88a"
		default:
			return "#8a7f72"
	}
}
