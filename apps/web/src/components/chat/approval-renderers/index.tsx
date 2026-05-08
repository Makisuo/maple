import { asRecord } from "./parse"
import {
	AddDashboardWidgetSummary,
	CreateDashboardSummary,
	RemoveDashboardWidgetSummary,
	ReorderDashboardWidgetsSummary,
	UpdateDashboardSummary,
	UpdateDashboardWidgetSummary,
} from "./dashboard"

interface SummaryProps {
	toolName: string
	input: unknown
}

const RENDERERS: Record<string, React.ComponentType<{ input: unknown }>> = {
	create_dashboard: CreateDashboardSummary,
	update_dashboard: UpdateDashboardSummary,
	add_dashboard_widget: AddDashboardWidgetSummary,
	update_dashboard_widget: UpdateDashboardWidgetSummary,
	remove_dashboard_widget: RemoveDashboardWidgetSummary,
	reorder_dashboard_widgets: ReorderDashboardWidgetsSummary,
}

export function ApprovalSummary({ toolName, input }: SummaryProps) {
	const Renderer = RENDERERS[toolName]
	if (Renderer) return <Renderer input={input} />
	return <KeyValueFallback input={input} />
}

function humanize(key: string): string {
	return key
		.replace(/_/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatValue(value: unknown): { kind: "scalar"; text: string } | { kind: "blob"; chars: number } {
	if (value === null || value === undefined) return { kind: "scalar", text: "—" }
	if (typeof value === "boolean") return { kind: "scalar", text: value ? "true" : "false" }
	if (typeof value === "number") return { kind: "scalar", text: String(value) }
	if (typeof value === "string") {
		if (value.length > 200) return { kind: "blob", chars: value.length }
		return { kind: "scalar", text: value }
	}
	try {
		const json = JSON.stringify(value)
		if (json.length > 200) return { kind: "blob", chars: json.length }
		return { kind: "scalar", text: json }
	} catch {
		return { kind: "scalar", text: String(value) }
	}
}

export function KeyValueFallback({ input }: { input: unknown }) {
	const obj = asRecord(input)
	if (!obj) {
		return (
			<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px] leading-snug">
				{safeStringify(input)}
			</pre>
		)
	}

	const entries = Object.entries(obj).filter(
		([, value]) => value !== undefined && value !== null && value !== "",
	)

	if (entries.length === 0) {
		return <div className="text-xs text-muted-foreground">No input fields</div>
	}

	return (
		<dl className="space-y-1 text-xs">
			{entries.map(([key, value]) => {
				const formatted = formatValue(value)
				return (
					<div key={key} className="flex items-baseline gap-2">
						<dt className="shrink-0 text-muted-foreground">{humanize(key)}</dt>
						<dd className="min-w-0 flex-1 truncate font-medium">
							{formatted.kind === "scalar" ? (
								<span>{formatted.text}</span>
							) : (
								<span className="text-muted-foreground italic">
									JSON · {formatted.chars} chars
								</span>
							)}
						</dd>
					</div>
				)
			})}
		</dl>
	)
}

export function safeStringify(input: unknown): string {
	try {
		return JSON.stringify(input, null, 2)
	} catch {
		return String(input)
	}
}
