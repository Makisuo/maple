import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { formatBytes } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { ArrowDownIcon, ArrowUpIcon, CircleQuestionIcon } from "@/components/icons"
import { ClampedText, type ClampLines } from "./clamped-text"
import { disclosed, useJsonPayload, ViewSwitch } from "./payload-view"
import { Pill } from "./pill"

/**
 * One invocation, both halves, joined by a spine.
 *
 * A call and its return are one event. Stacking two identically dressed
 * sections made the reader pair them by eye; putting them behind a selector —
 * as the span expansion's Tools tab did — made a missing result read exactly
 * like a tab nobody had opened. So both halves are always drawn, and the
 * direction is carried three ways at once: a hollow ↓ marker for what went in
 * and a solid ↑ marker for what came back, joined by a hairline in a fixed
 * gutter; a recessed ground under the input; and the words themselves.
 *
 * None of it rests on hue alone — the two grounds and the two markers still
 * separate in greyscale, and the failure tint lands on the RETURN only. The
 * arguments are not at fault for what came back.
 */

/** What a half needs to render. Structurally `TranscriptPayload`, which the
 *  transcript already builds; the span expansion builds it with `payload()`. */
export interface ToolIoPayload {
	readonly text: string
	readonly byteLength: number
	readonly lineCount: number
	readonly truncatedByEmitter: boolean
}

/** Arguments are context and clamp shorter; the result is what the reader
 *  opened the card for, and keeps the twelve-line body of every other payload. */
const IN_CLAMP: ClampLines = 8
const OUT_CLAMP: ClampLines = 14

const LABEL = "font-medium font-mono text-[10px] uppercase tracking-[0.1em]"
const META = "font-mono text-[10px] text-muted-foreground"
/** Fixed, so the two markers and every body below them share one lane. */
const GUTTER = "flex w-8 shrink-0 flex-col items-center gap-1.5 pt-2.5"

export function ToolIo({
	args,
	result,
	failed = false,
	resultMeta,
	missingResultNote,
	keyPrefix,
	openRows,
	onToggleRow,
}: {
	args: ToolIoPayload | undefined
	result: ToolIoPayload | undefined
	/** Tints the return half and its marker. Never the arguments. */
	failed?: boolean
	/** One more fact about the return — the span status, where a call failed. */
	resultMeta?: string
	/** Why no result was captured. The wording differs by how the call was
	 *  found, and only the caller knows which. */
	missingResultNote: string
	/** Namespaces this card's disclosure keys within the caller's set. */
	keyPrefix: string
	openRows: ReadonlySet<string>
	onToggleRow: (key: string) => void
}) {
	// Most vendors capture neither half by default, so this is the common case
	// and it gets one quiet line rather than two empty sections.
	if (args === undefined && result === undefined) {
		return (
			<div className="flex items-center gap-2.5 border-input border-t border-dashed bg-muted/20 px-3 py-2.5">
				<span aria-hidden className="flex shrink-0 items-center gap-0.5 text-muted-foreground/60">
					<ArrowDownIcon size={10} />
					<ArrowUpIcon size={10} />
				</span>
				<span className="min-w-0 text-muted-foreground text-xs">
					Payloads not captured — this span records the call&apos;s timing and identity only.
				</span>
			</div>
		)
	}

	return (
		<>
			{args === undefined ? (
				<MissingHalf label="Sent" note="not captured — the span carries no arguments attribute." />
			) : (
				<IoHalf
					direction="in"
					label="Sent"
					name="arguments"
					payload={args}
					clampLines={IN_CLAMP}
					textKey={`${keyPrefix}:args-text`}
					openRows={openRows}
					onToggleRow={onToggleRow}
				/>
			)}
			{result === undefined ? (
				<MissingHalf label="Returned" note={missingResultNote} />
			) : (
				<IoHalf
					direction="out"
					label={failed ? "Returned · error" : "Returned"}
					name="result"
					payload={result}
					meta={resultMeta}
					failed={failed}
					clampLines={OUT_CLAMP}
					textKey={`${keyPrefix}:result-text`}
					openRows={openRows}
					onToggleRow={onToggleRow}
				/>
			)}
		</>
	)
}

/**
 * The collapsed card's stand-in: both sizes on one line, in gutter order, so
 * the reader knows what expanding costs before they pay for it.
 */
export function ToolIoSummary({
	args,
	result,
}: {
	args: ToolIoPayload | undefined
	result: ToolIoPayload | undefined
}) {
	return (
		<span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-muted-foreground">
			<ArrowDownIcon size={10} aria-hidden className="text-muted-foreground/70" />
			{args === undefined ? "not captured" : formatBytes(args.byteLength)}
			<ArrowUpIcon size={10} aria-hidden className="ml-2 text-chart-4" />
			{result === undefined ? "not captured" : sizeLine(result)}
		</span>
	)
}

function IoHalf({
	direction,
	label,
	name,
	payload,
	meta,
	failed = false,
	clampLines,
	textKey,
	openRows,
	onToggleRow,
}: {
	direction: "in" | "out"
	label: string
	/** The captured attribute this half came from, kept beside the direction so
	 *  the reader can still name what they are looking at. */
	name: string
	payload: ToolIoPayload
	meta?: string
	failed?: boolean
	clampLines: ClampLines
	textKey: string
	openRows: ReadonlySet<string>
	onToggleRow: (key: string) => void
}) {
	const { formatted, isJson } = useJsonPayload(payload.text)
	const rawKey = `${textKey}:raw`
	const raw = disclosed(openRows, rawKey, false)

	return (
		<div
			className={cn(
				"flex items-stretch",
				// One step recessed under the input: the arguments are what the reader
				// already knows, and the return is what they came for. A black tint
				// rather than a ground token — light mode paints card and background
				// the same white, so a token swap would recess nothing there.
				direction === "in" ? "bg-black/[0.06]" : "border-border/60 border-t",
				direction === "out" && failed && "bg-destructive/5",
			)}
		>
			<div className={GUTTER}>
				<Marker direction={direction} failed={failed} />
				{/* Only the input half carries the spine — it ends at the marker it
				    joins to, rather than trailing off past the last body. */}
				{direction === "in" && <span aria-hidden className="w-px grow bg-input" />}
			</div>
			<div className="flex min-w-0 grow flex-col gap-2 pt-2.5 pr-3 pb-3">
				<div className="flex flex-wrap items-center gap-2">
					<span className={cn(LABEL, failed ? "text-destructive" : "text-foreground")}>
						{label}
					</span>
					<span className={META}>
						{[name, meta, sizeLine(payload)].filter(Boolean).join(" · ")}
					</span>
					{/* Emitter truncation, not the view's clamping — there is no "show
					    full" that can recover what was never recorded. */}
					{payload.truncatedByEmitter && (
						<Pill tone="warn" className="rounded-sm font-mono normal-case tracking-normal">
							truncated by the emitter
						</Pill>
					)}
					{/* Copies what is displayed: the pretty-printed JSON, or the raw text.
					    The switch only appears where the two differ. */}
					{payload.text !== "" && (
						<span className="-my-1 ml-auto flex items-center">
							{isJson && (
								<ViewSwitch
									rendered="json"
									raw={raw}
									onRawChange={(next) => next !== raw && onToggleRow(rawKey)}
									className="mr-1"
								/>
							)}
							<CopyButton value={raw ? payload.text : formatted} label={name} />
						</span>
					)}
				</div>
				{/* An emitter that recorded the truncation but kept no prefix leaves
				    nothing to show; an empty body would read as an empty payload. */}
				{payload.text !== "" && (
					<ClampedText
						text={raw ? payload.text : formatted}
						rendering={!raw && isJson ? "json" : "text"}
						mono
						clampLines={clampLines}
						toneClass={failed ? "text-destructive/90" : undefined}
						expanded={disclosed(openRows, textKey, false)}
						onToggleExpanded={() => onToggleRow(textKey)}
					/>
				)}
				{payload.truncatedByEmitter && (
					<p className="text-[11px] text-muted-foreground italic">
						Cut off here by the instrumentation, not by Maple — the tail was never recorded.
					</p>
				)}
			</div>
		</div>
	)
}

/** A half nobody recorded is still a half of this call, and it keeps its place
 *  in the gutter: a card that drops it reads as a call that had none. */
function MissingHalf({ label, note }: { label: string; note: string }) {
	return (
		<div className="flex items-center border-input border-t border-dashed bg-muted/20 py-2.5 pr-3">
			<span className="flex w-8 shrink-0 justify-center">
				<span className="flex size-4 items-center justify-center rounded-full border border-input border-dashed">
					<CircleQuestionIcon size={9} className="text-muted-foreground" />
				</span>
			</span>
			<span className={cn(LABEL, "shrink-0 pr-2.5 text-muted-foreground")}>{label}</span>
			<span className="min-w-0 text-muted-foreground text-xs">{note}</span>
		</div>
	)
}

/** Hollow going in, solid coming back: the pair still separates in greyscale,
 *  which colour alone would not. */
function Marker({ direction, failed }: { direction: "in" | "out"; failed: boolean }) {
	if (direction === "in") {
		return (
			<span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-input">
				<ArrowDownIcon size={9} aria-hidden className="text-muted-foreground" />
			</span>
		)
	}
	return (
		<span
			className={cn(
				"flex size-4 shrink-0 items-center justify-center rounded-full",
				failed ? "bg-destructive" : "bg-chart-4",
			)}
		>
			<ArrowUpIcon size={9} aria-hidden className="text-background" />
		</span>
	)
}

function sizeLine(payload: ToolIoPayload): string {
	const size = formatBytes(payload.byteLength)
	return payload.lineCount > 1 ? `${size} · ${payload.lineCount} lines` : size
}
