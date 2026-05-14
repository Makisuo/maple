import { lazy, Suspense, useState } from "react"
import {
	ChartBarIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleCheckIcon,
	CircleWarningIcon,
	CircleXmarkIcon,
	ClockIcon,
	CodeIcon,
	DatabaseIcon,
	LoaderIcon,
	MagnifierIcon,
	NetworkNodesIcon,
	PulseIcon,
} from "@/components/icons"
import type { IconComponent } from "@/components/icons"
import type { StructuredToolOutput } from "@maple/domain"
import { STRUCTURED_MARKER } from "./renderers"

const LazyToolRenderer = lazy(() =>
	import("./renderers/tool-renderer").then((m) => ({
		default: m.ToolRenderer,
	})),
)

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const toolLabels: Record<string, string> = {
	system_health: "System Health",
	diagnose_service: "Diagnose Service",
	find_errors: "Find Errors",
	error_detail: "Error Detail",
	search_traces: "Search Traces",
	find_slow_traces: "Find Slow Traces",
	inspect_trace: "Inspect Trace",
	search_logs: "Search Logs",
	list_metrics: "List Metrics",
	chart_traces: "Chart Traces",
	chart_logs: "Chart Logs",
	chart_metrics: "Chart Metrics",
	compare_periods: "Compare Periods",
	explore_attributes: "Explore Attributes",
}

const toolIcons: Record<string, IconComponent> = {
	system_health: PulseIcon,
	diagnose_service: MagnifierIcon,
	find_errors: CircleXmarkIcon,
	error_detail: CircleWarningIcon,
	search_traces: NetworkNodesIcon,
	find_slow_traces: ClockIcon,
	inspect_trace: MagnifierIcon,
	search_logs: DatabaseIcon,
	list_metrics: ChartBarIcon,
	chart_traces: ChartBarIcon,
	chart_logs: ChartBarIcon,
	chart_metrics: ChartBarIcon,
	compare_periods: ClockIcon,
	explore_attributes: DatabaseIcon,
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

type ToolStatus = "running" | "completed" | "error"

function deriveStatus(state: string): ToolStatus {
	switch (state) {
		case "output-available":
			return "completed"
		case "output-error":
		case "output-denied":
			return "error"
		default:
			return "running"
	}
}

function extractStructuredData(output: unknown): StructuredToolOutput | null {
	if (output == null || typeof output !== "object") return null
	if (!("content" in (output as Record<string, unknown>))) return null
	const content = (output as { content: unknown[] }).content
	if (!Array.isArray(content)) return null

	for (const item of content) {
		if (typeof item !== "object" || item == null) continue
		if (!("type" in item) || (item as { type: string }).type !== "text") continue
		if (!("text" in item)) continue
		const text = (item as { text: string }).text
		try {
			const parsed = JSON.parse(text)
			if (parsed && parsed[STRUCTURED_MARKER]) {
				return parsed as StructuredToolOutput
			}
		} catch {
			// Not JSON, skip
		}
	}
	return null
}

function extractOutputText(output: unknown): string | null {
	if (output == null) return null

	// MCP format: { content: [{ type: "text", text: "..." }] }
	if (typeof output === "object" && "content" in (output as Record<string, unknown>)) {
		const content = (output as { content: unknown[] }).content
		if (Array.isArray(content)) {
			return content
				.filter(
					(c): c is { type: "text"; text: string } =>
						typeof c === "object" &&
						c != null &&
						"type" in c &&
						(c as { type: string }).type === "text" &&
						"text" in c,
				)
				.filter((c) => {
					try {
						const parsed = JSON.parse(c.text)
						return !(parsed && parsed[STRUCTURED_MARKER])
					} catch {
						return true
					}
				})
				.map((c) => c.text)
				.join("\n")
		}
	}

	if (typeof output === "string") return output

	return JSON.stringify(output, null, 2)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ToolProps {
	toolName: string
	toolCallId: string
	state: string
	input?: unknown
	output?: unknown
	errorText?: string
}

export function Tool(props: ToolProps) {
	const { toolName, state, input, output, errorText } = props
	const status = deriveStatus(state)
	const label = toolLabels[toolName] ?? toolName
	const Icon = toolIcons[toolName] ?? CodeIcon

	const [open, setOpen] = useState(false)

	const hasInput =
		input != null && typeof input === "object" && Object.keys(input as Record<string, unknown>).length > 0
	const structuredData = extractStructuredData(output)
	const outputText = extractOutputText(output)
	const hasContent = hasInput || structuredData != null || outputText != null || errorText != null

	return (
		<div className="my-2 overflow-hidden rounded-lg border border-border/60 bg-muted/30 text-xs">
			{/* Header */}
			<button
				type="button"
				className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
				onClick={() => hasContent && setOpen((v) => !v)}
			>
				<Icon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="font-medium">{label}</span>

				<span className="ml-auto flex items-center gap-1.5">
					{status === "running" && (
						<>
							<span className="text-muted-foreground">Running…</span>
							<LoaderIcon className="size-3 animate-spin text-muted-foreground" />
						</>
					)}
					{status === "completed" && <CircleCheckIcon className="size-3.5 text-severity-info" />}
					{status === "error" && <CircleXmarkIcon className="size-3.5 text-destructive" />}
					{hasContent &&
						(open ? (
							<ChevronDownIcon className="size-3 text-muted-foreground" />
						) : (
							<ChevronRightIcon className="size-3 text-muted-foreground" />
						))}
				</span>
			</button>

			{/* Content */}
			{open && hasContent && (
				<div className="border-t border-border/50">
					{/* Input */}
					{hasInput && (
						<div className="border-b border-border/40 px-3 py-2">
							<p className="mb-1 font-medium text-muted-foreground">Arguments</p>
							<div className="space-y-0.5">
								{Object.entries(input as Record<string, unknown>)
									.filter(([, v]) => v != null)
									.map(([key, value]) => (
										<div key={key} className="flex gap-2">
											<span className="shrink-0 text-muted-foreground">{key}:</span>
											<span className="font-mono text-foreground">
												{typeof value === "string" ? value : JSON.stringify(value)}
											</span>
										</div>
									))}
							</div>
						</div>
					)}

					{/* Error */}
					{errorText != null && (
						<div className="px-3 py-2">
							<p className="mb-1 font-medium text-destructive">Error</p>
							<pre className="max-h-40 overflow-auto whitespace-pre-wrap text-destructive/80">
								{errorText}
							</pre>
						</div>
					)}

					{/* Output */}
					{(structuredData || outputText != null) && (
						<div className="px-3 py-2">
							{structuredData ? (
								<Suspense fallback={<div className="text-muted-foreground">Loading…</div>}>
									<LazyToolRenderer data={structuredData} />
								</Suspense>
							) : outputText != null ? (
								<>
									<p className="mb-1 font-medium text-muted-foreground">Result</p>
									<pre className="max-h-80 overflow-auto whitespace-pre-wrap text-muted-foreground">
										{outputText}
									</pre>
								</>
							) : null}
						</div>
					)}
				</div>
			)}
		</div>
	)
}
