export interface WidgetFixContext {
	dashboardId: string
	widgetId: string
	widgetTitle: string
	widgetJson: string
	errorTitle: string | null
	errorMessage: string | null
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

const toBase64Url = (input: string): string => {
	let raw: string
	if (typeof btoa !== "undefined") {
		try {
			raw = btoa(unescape(encodeURIComponent(input)))
		} catch {
			raw = btoa(input)
		}
	} else {
		raw = Buffer.from(input, "utf8").toString("base64")
	}
	return raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export const encodeWidgetFixContextToSearchParam = (ctx: WidgetFixContext): string =>
	toBase64Url(JSON.stringify(ctx))

export const decodeWidgetFixContextFromSearchParam = (raw: string): WidgetFixContext | undefined => {
	try {
		const json = fromBase64Url(raw)
		const parsed = JSON.parse(json) as WidgetFixContext
		if (!parsed || typeof parsed !== "object") return undefined
		if (typeof parsed.dashboardId !== "string" || typeof parsed.widgetId !== "string") return undefined
		return parsed
	} catch {
		return undefined
	}
}

export const widgetFixTabId = (ctx: Pick<WidgetFixContext, "dashboardId" | "widgetId">): string =>
	`widget-fix-${ctx.dashboardId}-${ctx.widgetId}`

export const widgetFixTabTitle = (ctx: Pick<WidgetFixContext, "widgetTitle">): string => {
	const base = ctx.widgetTitle.trim().length === 0 ? "widget" : ctx.widgetTitle
	const truncated = base.length > 24 ? `${base.slice(0, 24)}…` : base
	return `Fix: ${truncated}`
}

export const widgetFixSuggestions = (_ctx: WidgetFixContext): string[] => [
	"Try a different fix",
	"Explain what's wrong",
	"Show me what changed",
]

export const widgetFixAutoPrompt = "Fix this widget"
