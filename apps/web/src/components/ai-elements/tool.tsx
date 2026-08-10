import { lazy, memo, Suspense, useMemo, useState } from "react"
import {
	ChevronDownIcon,
	ChevronRightIcon,
	CircleCheckIcon,
	CircleXmarkIcon,
	LoaderIcon,
} from "@/components/icons"
import { cn } from "@maple/ui/lib/utils"
import type { StructuredToolOutput } from "@maple/domain"
import { STRUCTURED_MARKER } from "./renderers/constants"
import { ThinkingOrbIcon } from "./thinking-orb-icon"
import { toolIcon, toolLabel, toolOrbState } from "./tool-metadata"

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

/**
 * Only `live` rows get an orb.
 *
 * A live row is the trailing edge of a streaming turn — a standalone call with nothing after it —
 * so it is the one thing on screen that should be moving. Rows inside a `ToolGroup` are detail
 * behind a header that already carries an orb, and an expanded twelve-call burst would otherwise
 * be twelve canvases animating against each other.
 *
 * Within a row every state shares one size so the line doesn't shift as the call settles: `size-5`
 * for live rows, to match the orb's 20px, and `size-4` for grouped rows.
 */
function StatusGlyph({ status, toolName, live }: { status: ToolStatus; toolName: string; live: boolean }) {
	const size = live ? "size-5" : "size-4"
	if (status === "running") {
		return live ? (
			<ThinkingOrbIcon state={toolOrbState(toolName)} />
		) : (
			<LoaderIcon className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
		)
	}
	if (status === "error") return <CircleXmarkIcon className={cn(size, "shrink-0 text-destructive")} />
	return <CircleCheckIcon className={cn(size, "shrink-0 text-severity-info")} />
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

const isStructured = (value: unknown): value is StructuredToolOutput =>
	value != null && typeof value === "object" && STRUCTURED_MARKER in value

/**
 * Recover the rich payload a Maple tool renders as a table, chart or tree.
 *
 * Tool results arrive as `{ text, ui? }` — the chat agent's MCP adapter
 * (`apps/api/src/chat/`) splits the report text from the `__maple_ui` payload. The legacy shapes below are the
 * two the runtime produced before tool results could be structured JSON: a raw
 * MCP `{ content: [...] }` object, and a string with the UI JSON concatenated
 * onto the report. Both still exist in conversations recorded earlier, and a
 * replayed thread should keep rendering the way it did when it was live.
 */
export function extractStructuredData(output: unknown): StructuredToolOutput | null {
	if (output == null) return null

	if (typeof output === "object" && "ui" in (output as Record<string, unknown>)) {
		const ui = (output as { ui: unknown }).ui
		return isStructured(ui) ? ui : null
	}

	if (typeof output === "string") return parseStructuredFromText(output)

	if (typeof output === "object" && "content" in (output as Record<string, unknown>)) {
		const content = (output as { content: unknown[] }).content
		if (!Array.isArray(content)) return null
		for (const item of content) {
			const text = textOf(item)
			if (text === null) continue
			const parsed = parseStructuredFromText(text)
			if (parsed) return parsed
		}
	}
	return null
}

const textOf = (item: unknown): string | null =>
	typeof item === "object" &&
	item != null &&
	"type" in item &&
	(item as { type: string }).type === "text" &&
	"text" in item
		? (item as { text: string }).text
		: null

/** A JSON blob carrying the UI marker, possibly one paragraph of a joined string. */
function parseStructuredFromText(text: string): StructuredToolOutput | null {
	for (const chunk of text.split("\n\n")) {
		const trimmed = chunk.trim()
		if (!trimmed.startsWith("{")) continue
		try {
			const parsed: unknown = JSON.parse(trimmed)
			if (isStructured(parsed)) return parsed
		} catch {
			// Not JSON — ordinary report text.
		}
	}
	return null
}

export function extractOutputText(output: unknown): string | null {
	if (output == null) return null

	if (typeof output === "object" && "text" in (output as Record<string, unknown>)) {
		const text = (output as { text: unknown }).text
		if (typeof text === "string") return text
	}

	if (typeof output === "string") return stripStructuredChunks(output)

	// Legacy MCP shape: { content: [{ type: "text", text: "..." }] }
	if (typeof output === "object" && "content" in (output as Record<string, unknown>)) {
		const content = (output as { content: unknown[] }).content
		if (Array.isArray(content)) {
			return content
				.map(textOf)
				.filter((text): text is string => text !== null && parseStructuredFromText(text) === null)
				.join("\n")
		}
	}

	return JSON.stringify(output, null, 2)
}

/** Drop the UI payload from a legacy joined string so it isn't shown as raw JSON. */
const stripStructuredChunks = (text: string): string =>
	text
		.split("\n\n")
		.filter((chunk) => parseStructuredFromText(chunk) === null)
		.join("\n\n")

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
	/** This row is the turn's live edge, so its running state is an orb rather than a quiet loader. */
	live?: boolean
}

/**
 * A single, cardless tool line: status glyph, tool icon, label, salient-argument
 * summary, and an inline-expandable detail panel. The bordered container is owned
 * by the parent (standalone `Tool` shell or `ToolGroup`) so rows never nest cards.
 */
export const ToolRow = memo(function ToolRow(props: ToolProps) {
	const { toolName, state, input, output, errorText, live = false } = props
	const status = deriveStatus(state)
	const label = toolLabel(toolName)
	const Icon = toolIcon(toolName)
	const summary = useMemo(() => toolSummary(input), [input])

	const [open, setOpen] = useState(false)

	const hasInput =
		input != null && typeof input === "object" && Object.keys(input as Record<string, unknown>).length > 0
	// Both walk the output, `split("\n\n")` it and `JSON.parse` every `{`-prefixed chunk. A settled
	// tool result never changes, but this used to re-run on every render of the transcript — and
	// Maple's tool outputs are warehouse rows and trace payloads, so that was the single most
	// expensive thing a streamed token could trigger.
	const structuredData = useMemo(() => extractStructuredData(output), [output])
	const outputText = useMemo(() => extractOutputText(output), [output])
	const hasContent = hasInput || structuredData != null || outputText != null || errorText != null

	return (
		<div className="text-sm">
			<button
				type="button"
				className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/40 disabled:cursor-default disabled:hover:bg-transparent"
				disabled={!hasContent}
				onClick={() => setOpen((v) => !v)}
			>
				<StatusGlyph status={status} toolName={toolName} live={live} />
				{/* The tool icon differentiates rows when you're scanning a group of a dozen. A
				    standalone row has nothing to differentiate itself from, and its label already
				    names the tool — so next to the orb it was just a second glyph competing with a
				    finely-dotted one. Dropped in both of a live row's states, so nothing shifts
				    when the call settles. */}
				{live ? null : <Icon className="size-4 shrink-0 text-muted-foreground" />}
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
})

/** Standalone (non-grouped) tool call: one `ToolRow` in its own hairline shell. */
export const Tool = memo(function Tool(props: ToolProps) {
	return (
		<div className="overflow-hidden rounded-lg border border-border/60 bg-muted/20">
			<ToolRow {...props} />
		</div>
	)
})
