// The error alert banner shared by span detail panels and log detail views.
// Previously four near-identical copies across web and local-ui; parameterize
// on the title, an optional exception-type chip, and the "Copy as prompt"
// payload instead of forking the markup again.
//
// Laid out as a plain card rather than `Alert`: that component's icon-column
// grid indents everything under the glyph, which costs horizontal room the
// error text needs and clips the body in a narrow detail panel.

import { useMemo, useState } from "react"

import { BracketsCurlyIcon, CircleWarningIcon, SparkleIcon } from "./icons"
import { CopyButton } from "./ui/copy-button"
import { useCopy } from "../hooks/use-copy"
import { JSON_TOKEN_COLOR, parseErrorBody, splitErrorText, tokenizeJson } from "../lib/error-body"
import { formatErrorPrompt } from "../lib/error-prompt"
import { cn } from "../lib/utils"

export interface ErrorSectionProps {
	message: string
	/** Banner heading; e.g. "Fatal" for fatal-severity logs. */
	title?: string
	/** Monospace chip beside the title — typically `exception.type`. */
	badge?: string
	/**
	 * Telemetry context for the "Copy as prompt" action; the button renders only
	 * when this is present. `message` is included automatically.
	 */
	prompt?: {
		serviceName: string
		/** Span name / operation. Omitted for logs that aren't tied to an operation. */
		operation?: string
		attributes?: Record<string, string>
	}
	className?: string
}

function JsonBody({ source }: { source: string }) {
	const tokens = useMemo(() => tokenizeJson(source), [source])
	return (
		<>
			{tokens.map((token, index) => (
				<span
					// Tokens are positional and the list is rebuilt whole whenever
					// `source` changes, so the index is the identity.
					key={index}
					style={{ color: JSON_TOKEN_COLOR[token.type] }}
				>
					{token.text}
				</span>
			))}
		</>
	)
}

function TextBody({ source }: { source: string }) {
	const lines = useMemo(() => splitErrorText(source), [source])
	return (
		<>
			{lines.map((line, index) => (
				<span key={index} className={cn("block", line.frame && "text-destructive/55")}>
					{line.text || " "}
				</span>
			))}
		</>
	)
}

/** Lines of the body kept visible while collapsed. Tall enough to show the
 * shape of a payload — a couple of keys, or the message plus its first frame —
 * without the banner taking over the panel. */
const COLLAPSED_LINES = 3

/** `leading-relaxed`. Kept as a number so the clamp can be expressed in `em`,
 * which tracks the body's font size wherever this card is embedded. */
const LINE_HEIGHT = 1.625

export function ErrorSection({ message, title = "Error", badge, prompt, className }: ErrorSectionProps) {
	const [expanded, setExpanded] = useState(false)
	const body = useMemo(() => parseErrorBody(message), [message])
	const { copy, status } = useCopy({ label: "Error" })

	// Measured on the painted body, so the toggle appears exactly when something
	// is actually hidden.
	const lineCount = useMemo(() => body.full.split("\n").length, [body.full])
	const isLong = lineCount > COLLAPSED_LINES || message.length > 160
	const clamped = isLong && !expanded

	return (
		<div
			className={cn(
				"mx-3 my-2 rounded-lg border border-destructive/25 bg-destructive/4 px-3 py-2.5",
				className,
			)}
		>
			<div className="flex min-w-0 items-center gap-2">
				<CircleWarningIcon size={14} className="shrink-0 text-destructive" />

				<span className="shrink-0 font-medium text-[11px] text-destructive uppercase tracking-wide">
					{title}
				</span>

				{badge && (
					<span className="min-w-0 truncate font-mono text-[11px] text-foreground/80" title={badge}>
						{badge}
					</span>
				)}

				{body.format === "json" && (
					<span
						className="flex shrink-0 items-center gap-1 rounded border border-destructive/25 px-1 py-px font-mono text-[9px] text-destructive/70 uppercase"
						title="JSON payload"
					>
						<BracketsCurlyIcon size={9} />
						json
					</span>
				)}

				{prompt && (
					<CopyButton
						value={() => formatErrorPrompt({ message, ...prompt })}
						label="error as an AI prompt"
						copiedLabel="Prompt copied"
						tooltip
						idleIcon={SparkleIcon}
						iconSize={12}
						className="ml-auto size-5 shrink-0 rounded text-destructive/70 hover:bg-destructive/10 hover:text-destructive sm:size-5"
					/>
				)}
			</div>

			{/* The body is the copy affordance — a detail panel already carries
			    enough glyphs, and the thing you want on the clipboard is exactly
			    the thing you are pointing at. */}
			<button
				type="button"
				aria-label="Copy error message"
				title="Click to copy"
				data-copy-status={status}
				onClick={() => void copy(body.full)}
				className={cn(
					"mt-1.5 block w-full cursor-copy rounded text-left font-mono text-[11px] text-foreground/90 leading-relaxed",
					"transition-colors duration-150 hover:text-foreground motion-reduce:transition-none",
					"data-[copy-status=copied]:text-severity-info",
				)}
			>
				{/* Collapsing is a height clamp, not a different rendering: the
				    highlighting is on from the first line, and the last visible one
				    fades out so it reads as cut off rather than as the end. A
				    `line-clamp` can't do this — the body nests block lines and
				    per-token spans, which `-webkit-box` does not lay out. */}
				<pre
					className={cn(
						// The two overflow states are mutually exclusive rather than
						// layered: `overflow-hidden` is a shorthand and would race the
						// `overflow-y` longhand on stylesheet order.
						"whitespace-pre-wrap break-words",
						clamped
							? "overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-1.25em),transparent)]"
							: "max-h-64 overflow-y-auto",
					)}
					style={clamped ? { maxHeight: `${COLLAPSED_LINES * LINE_HEIGHT}em` } : undefined}
				>
					{body.format === "json" ? (
						<JsonBody source={body.full} />
					) : (
						<TextBody source={body.full} />
					)}
				</pre>
			</button>

			{isLong && (
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded((open) => !open)}
					className="mt-1 rounded text-[11px] text-destructive/70 hover:text-destructive"
				>
					{expanded ? "Show less" : "Show more"}
				</button>
			)}
		</div>
	)
}
