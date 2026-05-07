export type AutoContext =
	| { kind: "service"; id: string; serviceName: string }
	| { kind: "trace"; id: string; traceId: string }
	| { kind: "dashboard"; id: string; dashboardId: string; widgetId?: string }
	| { kind: "error_type"; id: string; errorType: string }
	| { kind: "error_issue"; id: string; issueId: string }
	| { kind: "alert_rule"; id: string; ruleId: string }
	| { kind: "host"; id: string; hostName: string }
	| { kind: "logs_explorer"; id: string }
	| { kind: "metrics_explorer"; id: string }
	| { kind: "traces_explorer"; id: string }
	| { kind: "service_map"; id: string }

export interface PageContextPayload {
	pathname: string
	contexts: AutoContext[]
}

export function autoContextLabel(ctx: AutoContext): string {
	switch (ctx.kind) {
		case "service":
			return `Service: ${ctx.serviceName}`
		case "trace":
			return `Trace: ${ctx.traceId.slice(0, 8)}…`
		case "dashboard":
			return ctx.widgetId
				? `Dashboard widget: ${ctx.dashboardId.slice(0, 8)}…/${ctx.widgetId.slice(0, 6)}…`
				: `Dashboard: ${ctx.dashboardId.slice(0, 8)}…`
		case "error_type":
			return `Error type: ${ctx.errorType}`
		case "error_issue":
			return `Error issue: ${ctx.issueId.slice(0, 8)}…`
		case "alert_rule":
			return `Alert rule: ${ctx.ruleId.slice(0, 8)}…`
		case "host":
			return `Host: ${ctx.hostName}`
		case "logs_explorer":
			return "Logs explorer"
		case "metrics_explorer":
			return "Metrics explorer"
		case "traces_explorer":
			return "Traces explorer"
		case "service_map":
			return "Service map"
	}
}

const decode = (s: string) => {
	try {
		return decodeURIComponent(s)
	} catch {
		return s
	}
}

export function deriveAutoContexts(pathname: string): AutoContext[] {
	if (!pathname || pathname === "/") return []
	const parts = pathname.split("/").filter(Boolean)
	if (parts.length === 0) return []

	const [head, second, third, fourth] = parts

	switch (head) {
		case "services":
			if (second && second !== "index") {
				const serviceName = decode(second)
				return [{ kind: "service", id: `service:${serviceName}`, serviceName }]
			}
			return []
		case "traces":
			if (second) {
				const traceId = decode(second)
				return [{ kind: "trace", id: `trace:${traceId}`, traceId }]
			}
			return [{ kind: "traces_explorer", id: "traces_explorer" }]
		case "dashboards":
			if (second && second !== "templates") {
				const dashboardId = decode(second)
				const widgetId = third === "widgets" && fourth ? decode(fourth) : undefined
				return [
					{
						kind: "dashboard",
						id: widgetId ? `dashboard:${dashboardId}:${widgetId}` : `dashboard:${dashboardId}`,
						dashboardId,
						widgetId,
					},
				]
			}
			return []
		case "errors":
			if (second === "issues" && third) {
				const issueId = decode(third)
				return [{ kind: "error_issue", id: `error_issue:${issueId}`, issueId }]
			}
			if (second && second !== "issues") {
				const errorType = decode(second)
				return [{ kind: "error_type", id: `error_type:${errorType}`, errorType }]
			}
			return []
		case "alerts":
			if (second && second !== "create") {
				const ruleId = decode(second)
				return [{ kind: "alert_rule", id: `alert_rule:${ruleId}`, ruleId }]
			}
			return []
		case "infra":
			if (second && second !== "kubernetes") {
				const hostName = decode(second)
				return [{ kind: "host", id: `host:${hostName}`, hostName }]
			}
			return []
		case "logs":
			return [{ kind: "logs_explorer", id: "logs_explorer" }]
		case "metrics":
			return [{ kind: "metrics_explorer", id: "metrics_explorer" }]
		case "service-map":
			return [{ kind: "service_map", id: "service_map" }]
		default:
			return []
	}
}

export function suggestionsForContexts(contexts: AutoContext[]): string[] | null {
	if (contexts.length === 0) return null
	const ctx = contexts[0]
	switch (ctx.kind) {
		case "service":
			return [
				`Diagnose latency for ${ctx.serviceName}`,
				`What errors are happening in ${ctx.serviceName}?`,
				`Show recent slow traces for ${ctx.serviceName}`,
				`Compare ${ctx.serviceName} to last week`,
			]
		case "trace":
			return [
				"Why is this trace slow?",
				"Summarize the spans in this trace",
				"Did this trace produce any errors?",
			]
		case "dashboard":
			return [
				"Summarize what this dashboard shows",
				"Suggest a widget I'm missing",
				"Explain anomalies in this dashboard",
			]
		case "error_type":
			return [
				`Show me sample traces for ${ctx.errorType}`,
				`Which services are affected by ${ctx.errorType}?`,
				`When did ${ctx.errorType} start?`,
			]
		case "error_issue":
			return [
				"Summarize this error issue",
				"Show recent occurrences of this issue",
				"Which services are affected?",
			]
		case "alert_rule":
			return [
				"Why did this alert fire?",
				"Show recent incidents for this rule",
				"What metric is this rule watching?",
			]
		case "host":
			return [
				`Show CPU and memory trends for ${ctx.hostName}`,
				`Are there any errors from ${ctx.hostName}?`,
				`What services are running on ${ctx.hostName}?`,
			]
		case "logs_explorer":
			return ["Find errors in the last 15 minutes", "Show me warnings", "Mine log patterns"]
		case "metrics_explorer":
			return ["List the most active metrics", "Show throughput trends", "Find slow services"]
		case "traces_explorer":
			return ["Show me the slowest traces", "Find traces with errors", "Show traces by P99 latency"]
		case "service_map":
			return [
				"Which services have the highest error rate?",
				"What's the slowest dependency?",
				"Map the request flow",
			]
	}
}

const REFERRER_KEY = "maple-chat-referrer"

export function captureChatReferrer(pathname: string): void {
	if (typeof window === "undefined") return
	if (pathname.startsWith("/chat")) return
	try {
		window.sessionStorage.setItem(REFERRER_KEY, pathname)
	} catch {}
}

export function readChatReferrer(): string | null {
	if (typeof window === "undefined") return null
	try {
		return window.sessionStorage.getItem(REFERRER_KEY)
	} catch {
		return null
	}
}

export function clearChatReferrer(): void {
	if (typeof window === "undefined") return
	try {
		window.sessionStorage.removeItem(REFERRER_KEY)
	} catch {}
}
