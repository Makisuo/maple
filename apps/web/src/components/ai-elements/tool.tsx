import { lazy, Suspense, useState } from "react"
import {
	ChevronDownIcon,
	ChevronRightIcon,
	CircleCheckIcon,
	CircleXmarkIcon,
	LoaderIcon,
} from "@/components/icons"
import type { StructuredToolOutput } from "@maple/domain"
import { STRUCTURED_MARKER } from "./renderers/constants"
import { toolIcon, toolLabel } from "./tool-metadata"

export { normalizeToolName, toolLabel } from "./tool-metadata"

const LazyToolRenderer = lazy(() =>
	import("./renderers/tool-renderer").then((m) => ({
		default: m.ToolRenderer,
	})),
)

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

function StatusGlyph({ status }: { status: ToolStatus }) {
	if (status === "running")
		return (
			<LoaderIcon className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
		)
	if (status === "error") return <CircleXmarkIcon className="size-4 shrink-0 text-destructive" />
	return <CircleCheckIcon className="size-4 shrink-0 text-severity-info" />
}

// Pick the most salient input field for a one-line row summary, e.g. `service=api`.
const SUMMARY_KEYS = [
	"service",
	"serviceName",
	"query",
	"q",
	"traceId",
	"spanId",
	"name",
	"metric",
	"errorId",
	"issueId",
	"dashboardId",
	"ruleId",
]

// Boilerplate args present on nearly every Maple tool — never use them as the summary.
const SUMMARY_EXCLUDE = new Set([
	"start_time",
	"end_time",
	"startTime",
	"endTime",
	"limit",
	"offset",
	"interval",
	"granularity",
	"org_id",
	"orgId",
])

function truncate(value: string, max = 40): string {
	const trimmed = value.trim()
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function toolSummary(input: unknown): string | undefined {
	if (input == null || typeof input !== "object") return undefined
	const obj = input as Record<string, unknown>
	const format = (key: string, value: unknown): string | undefined => {
		if (typeof value === "string" && value.trim()) return `${key}=${truncate(value)}`
		if (typeof value === "number" || typeof value === "boolean") return `${key}=${value}`
		return undefined
	}
	for (const key of SUMMARY_KEYS) {
		const formatted = format(key, obj[key])
		if (formatted) return formatted
	}
	for (const [key, value] of Object.entries(obj)) {
		if (SUMMARY_EXCLUDE.has(key)) continue
		const formatted = format(key, value)
		if (formatted) return formatted
	}
	return undefined
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

/**
 * A single, cardless tool line: status glyph, tool icon, label, salient-argument
 * summary, and an inline-expandable detail panel. The bordered container is owned
 * by the parent (standalone `Tool` shell or `ToolGroup`) so rows never nest cards.
 */
export function ToolRow(props: ToolProps) {
	const { toolName, state, input, output, errorText } = props
	const status = deriveStatus(state)
	const label = toolLabel(toolName)
	const Icon = toolIcon(toolName)
	const summary = toolSummary(input)

	const [open, setOpen] = useState(false)

	const hasInput =
		input != null && typeof input === "object" && Object.keys(input as Record<string, unknown>).length > 0
	const structuredData = extractStructuredData(output)
	const outputText = extractOutputText(output)
	const hasContent = hasInput || structuredData != null || outputText != null || errorText != null

	return (
		<div className="text-sm">
			<button
				type="button"
				className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/40 disabled:cursor-default disabled:hover:bg-transparent"
				disabled={!hasContent}
				onClick={() => setOpen((v) => !v)}
			>
				<StatusGlyph status={status} />
				<Icon className="size-4 shrink-0 text-muted-foreground" />
				<span className="shrink-0 font-medium text-foreground">{label}</span>
				{summary ? (
					<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
						<span className="mr-1 text-muted-foreground/40">·</span>
						<span className="font-mono">{summary}</span>
					</span>
				) : (
					<span className="flex-1" />
				)}
				{hasContent &&
					(open ? (
						<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
					) : (
						<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
					))}
			</button>

			{open && hasContent && (
				<div className="space-y-2 border-t border-border/40 px-3 pb-2.5 pl-[2.375rem] pt-2.5 text-xs">
					{hasInput && (
						<div>
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

					{errorText != null && (
						<div>
							<p className="mb-1 font-medium text-destructive">Error</p>
							<pre className="max-h-40 overflow-auto whitespace-pre-wrap text-destructive/80">
								{errorText}
							</pre>
						</div>
					)}

					{(structuredData || outputText != null) && (
						<div>
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

/** Standalone (non-grouped) tool call: one `ToolRow` in its own hairline shell. */
export function Tool(props: ToolProps) {
	return (
		<div className="my-2 overflow-hidden rounded-lg border border-border/60 bg-muted/20">
			<ToolRow {...props} />
		</div>
	)
}
