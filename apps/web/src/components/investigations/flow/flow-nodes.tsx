/**
 * The canvas's four node shapes.
 *
 * Kind is carried by three things at once — a distinct icon, whether that icon
 * sits in a filled tile, and the node's fill against the canvas. Colour alone
 * never distinguishes a node, so the graph still reads with the hue stripped out.
 */
import { memo } from "react"
import { Link } from "@tanstack/react-router"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatRelativeTimeOrDate, toEpochMs } from "@maple/ui/lib/time-format"

import {
	AlertWarningIcon,
	BellIcon,
	BoltIcon,
	ChartBarIcon,
	CircleCheckIcon,
	CircleXmarkIcon,
	ClockIcon,
	CodeIcon,
	EyeIcon,
	type IconComponent,
	LoaderIcon,
	MagnifierIcon,
	NetworkNodesIcon,
	RadioCheckedIcon,
	RocketIcon,
	ServerIcon,
	SlidersIcon,
	SquareTerminalIcon,
} from "@/components/icons"
import type { LensTone } from "../lens-derive"
import type { ActionKind } from "./action-target"
import type {
	ActionNodeData,
	FlowGlyph,
	LensNodeData,
	LensOverflowNodeData,
	PendingVerdictNodeData,
	SpineNodeData,
} from "./provenance-graph"

/* -------------------------------------------------------------------------------------------------
 * Shared
 * -----------------------------------------------------------------------------------------------*/

const TONE_TEXT: Record<LensTone, string> = {
	muted: "text-muted-foreground",
	primary: "text-primary",
	success: "text-success",
	info: "text-info",
	warning: "text-warning",
	destructive: "text-destructive",
}

const TONE_BORDER: Record<LensTone, string> = {
	muted: "border-border",
	primary: "border-primary",
	success: "border-success",
	info: "border-info",
	warning: "border-warning",
	destructive: "border-destructive",
}

const GLYPH: Record<FlowGlyph, IconComponent> = {
	issue: AlertWarningIcon,
	check: RadioCheckedIcon,
	incident: BellIcon,
	investigation: MagnifierIcon,
	verdict: CircleCheckIcon,
}

const LENS_GLYPH: Record<LensNodeData["state"]["icon"], IconComponent> = {
	pending: LoaderIcon,
	running: LoaderIcon,
	confirmed: EyeIcon,
	ruledOut: CircleXmarkIcon,
	deadline: ClockIcon,
	failed: CircleXmarkIcon,
}

/** The eyebrow strip: an icon in its tile, then the kind in caps. */
const EYEBROW = "text-[10px] font-medium uppercase tracking-[0.12em]"
/** Both handles are hidden — this graph is read-only, nothing connects to anything. */
const HANDLE = "!size-0 !min-h-0 !min-w-0 !border-0 !bg-transparent"

function Ports() {
	return (
		<>
			<Handle type="target" position={Position.Left} className={HANDLE} isConnectable={false} />
			<Handle type="source" position={Position.Right} className={HANDLE} isConnectable={false} />
		</>
	)
}

/* -------------------------------------------------------------------------------------------------
 * Spine — issue, check, incident, investigation, verdict
 * -----------------------------------------------------------------------------------------------*/

export const FlowSpineNode = memo(function FlowSpineNode({ data }: NodeProps & { data: SpineNodeData }) {
	const Icon = GLYPH[data.glyph]
	const body = (
		<>
			<div className="flex items-center gap-1.5">
				<span
					className={cn(
						"relative flex size-5.5 shrink-0 items-center justify-center rounded-sm",
						data.current ? "bg-primary text-primary-foreground" : "bg-muted",
						data.lifted && !data.current ? "bg-background" : null,
					)}
				>
					{/*
					 * The live ring. Depth by tone, never by shadow — this is a ring that
					 * expands and fades, the same `severity-pulse` the infra board uses,
					 * not a glow. It sits behind the tile so the glyph stays legible, and
					 * it is the reason a reader can tell at a glance that the amber node
					 * is running rather than merely being the one they are looking at.
					 */}
					{data.live ? (
						<span
							aria-hidden
							className="provenance-live-ring absolute inset-0 rounded-sm border border-primary"
						/>
					) : null}
					<Icon
						size={13}
						className={cn(
							"relative",
							data.current
								? null
								: data.glyph === "verdict"
									? "text-info"
									: "text-severity-error",
						)}
					/>
				</span>
				<span
					className={cn(
						EYEBROW,
						"min-w-0 flex-1 truncate",
						data.current ? "tracking-[0.06em] text-primary" : "text-muted-foreground",
					)}
				>
					{data.eyebrow}
				</span>
			</div>
			<p
				className={cn(
					"line-clamp-2 break-words font-mono text-xs leading-[1.35] text-foreground",
					data.current ? "text-sm" : null,
				)}
				title={data.titleHint ?? data.title}
			>
				{data.title}
			</p>
			{/*
			 * The stage, while there is one. It is the answer to the question a reader
			 * opens a running investigation to ask — "what is it doing?" — and the node
			 * that *is* the running thing was the only one on the canvas not saying.
			 */}
			{data.phase ? (
				<p className={cn(EYEBROW, "truncate text-[9px] leading-3 text-primary")} title={data.phase}>
					{data.phase}
				</p>
			) : null}
			{data.status ? (
				<p className="flex items-baseline gap-1 text-[9px] leading-3">
					<span className="shrink-0 font-medium tracking-[0.06em] text-severity-error">
						{data.status}
					</span>
					{data.detail ? (
						<span className="min-w-0 flex-1 truncate text-muted-foreground">{data.detail}</span>
					) : null}
				</p>
			) : null}
			{data.note ? (
				<p className="whitespace-pre-line text-[10px] leading-[1.4] text-muted-foreground">
					{data.note}
					{data.current ? "\nyou are here" : null}
				</p>
			) : null}
			{/*
			 * When this step happened, along the bottom edge. `mt-auto` rather than a
			 * flow position: the card is centred, and the footer has to sit on the
			 * bottom rule whether the title above it ran to one line or two.
			 *
			 * Relative-or-date, not plain relative — a canvas opened on a two-month-old
			 * investigation would otherwise read "63d ago" on every card, which is a
			 * number nobody converts back into a date.
			 */}
			{data.at ? (
				<time
					dateTime={data.at}
					title={new Date(toEpochMs(data.at)).toLocaleString()}
					className="mt-auto pt-0.5 font-mono text-[9px] leading-3 text-muted-foreground/70 tabular-nums"
				>
					{formatRelativeTimeOrDate(data.at)}
				</time>
			) : null}
		</>
	)

	// `overflow-hidden`: node heights are fixed by the layout, so an unusually long
	// exception name has to clip at the border rather than spill a half-glyph row
	// across the canvas.
	const shell = cn(
		"flex size-full flex-col gap-1.5 overflow-hidden rounded-lg border px-3 py-2.5",
		// A stamped card packs top-down so its footer can hold the bottom rule; an
		// unstamped one has a row's worth of slack and centres instead, which reads
		// as deliberate where a top-aligned card with a gap under it reads as a bug.
		data.at ? "justify-start" : "justify-center",
		data.current
			? "border-primary bg-card"
			: data.lifted
				? "border-border bg-muted"
				: "border-border bg-card",
	)

	return (
		<>
			<Ports />
			{data.href ? (
				<Link
					to={data.href}
					className={cn(shell, "transition-colors hover:border-primary/60")}
					title={data.titleHint ?? data.title}
				>
					{body}
				</Link>
			) : (
				<div className={shell}>{body}</div>
			)}
		</>
	)
})

/* -------------------------------------------------------------------------------------------------
 * Lens
 * -----------------------------------------------------------------------------------------------*/

export const FlowLensNode = memo(function FlowLensNode({ data }: NodeProps & { data: LensNodeData }) {
	const { state } = data
	const Icon = LENS_GLYPH[state.icon]
	const running = state.icon === "running"
	/** Queued or running — a lane whose result has not landed, whatever it is doing. */
	const waiting = running || state.icon === "pending"
	return (
		<>
			<Ports />
			<div
				className={cn(
					"relative flex size-full flex-col justify-center gap-1 overflow-hidden rounded-md border bg-background px-2.5",
					TONE_BORDER[state.tone],
					state.dashed ? "border-dashed" : null,
				)}
				// The result first: the lane's title is already printed on the node, and
				// what a reader hovers for is *why* it held or didn't — which is the
				// line the deleted checks rail used to carry.
				title={[data.title, data.result || data.question].filter(Boolean).join("\n")}
			>
				<p
					className={cn(
						"truncate font-mono text-xs leading-[1.3]",
						state.struck ? "text-muted-foreground line-through" : "text-foreground",
					)}
				>
					{data.title}
				</p>
				<p className="flex items-center gap-1.5">
					<Icon
						size={11}
						className={cn(
							"shrink-0",
							TONE_TEXT[state.tone],
							// Spec rule 04: a running lane moves, and only a running lane.
							// It spins rather than pulses — the glyph is a loader, and a
							// loader that fades in and out reads as a disabled control.
							running ? "animate-spin motion-reduce:animate-none" : null,
						)}
					/>
					<span
						className={cn(
							"shrink-0 text-[9px] font-medium tracking-[0.06em]",
							TONE_TEXT[state.tone],
						)}
					>
						{state.word}
					</span>
					<span className="min-w-0 flex-1 text-right font-mono text-[9px] text-muted-foreground tabular-nums">
						{data.elapsed ?? ""}
					</span>
				</p>
				{/*
				 * What the lane is doing, on the lane. Reserved to running lanes: a
				 * settled one's note describes a step it has already left, and the row
				 * that matters there is the result, which the tooltip carries.
				 */}
				{running && data.progressNote ? (
					<p
						className="truncate text-[9px] leading-3 text-muted-foreground"
						title={data.progressNote}
					>
						{data.progressNote}
					</p>
				) : waiting ? (
					/*
					 * The same row, held open by a bar, for a lane that has not said
					 * anything yet — a queued one, or a running one between notes. The
					 * card's height is fixed at 64px either way, so without this the
					 * third row is simply blank and a queued lane reads as a finished
					 * lane whose result failed to render.
					 */
					<Skeleton className="h-1.5 w-2/3 rounded-full" />
				) : null}
				{/*
				 * An indeterminate sweep along the bottom edge. The 11px spinner stops
				 * being readable at the 0.68 zoom a narrow window forces; a bar crossing
				 * the full 146px width does not.
				 */}
				{running ? (
					<span aria-hidden className="absolute inset-x-0 bottom-0 h-px overflow-hidden">
						<span className="provenance-lens-sweep absolute inset-y-0 w-1/3 bg-primary" />
					</span>
				) : null}
			</div>
		</>
	)
})

/**
 * The step after the fan while the verdict is still being reached.
 *
 * Dashed and muted throughout — it is the one node on the canvas that describes
 * work rather than a result, and it must not be mistaken at a glance for the
 * real verdict node it will be replaced by.
 */
export const FlowPendingVerdictNode = memo(function FlowPendingVerdictNode({
	data,
}: NodeProps & { data: PendingVerdictNodeData }) {
	return (
		<>
			<Ports />
			<div className="relative flex size-full flex-col justify-center gap-1.5 overflow-hidden rounded-lg border border-dashed bg-background px-3 py-2.5">
				<div className="flex items-start gap-1.5">
					<span className="flex size-5.5 shrink-0 items-center justify-center rounded-sm border border-dashed">
						<ClockIcon size={13} className="text-muted-foreground" />
					</span>
					{/*
					 * Wraps rather than truncates. "AWAITING VERDICT" does not fit the
					 * 146px node on one line at the eyebrow's tracking, and the word IS
					 * this node — a node reading "AWAITING VE…" says nothing at all.
					 */}
					<span className={cn(EYEBROW, "min-w-0 flex-1 leading-[1.3] text-muted-foreground")}>
						{data.word}
					</span>
				</div>
				{data.note ? (
					<p className="text-[10px] leading-[1.4] text-muted-foreground">{data.note}</p>
				) : null}
				{/*
				 * Two bars where the verdict node prints its suspected cause and its
				 * confidence. Bars rather than words on purpose: this node is forbidden
				 * to state a finding, and a bar is the one way to say "a finding lands
				 * here" without making one up. They also stop the node reading as a
				 * dead end — the chain visibly continues past the fan.
				 */}
				<div aria-hidden className="flex flex-col gap-1 pt-0.5">
					<Skeleton className="h-1.5 w-full rounded-full" />
					<Skeleton className="h-1.5 w-1/2 rounded-full" />
				</div>
				{/* The same sweep the running lens lanes wear, so the canvas's live nodes share one motion. */}
				<span aria-hidden className="absolute inset-x-0 bottom-0 h-px overflow-hidden">
					<span className="provenance-lens-sweep absolute inset-y-0 w-1/3 bg-primary" />
				</span>
			</div>
		</>
	)
})

export const FlowLensOverflowNode = memo(function FlowLensOverflowNode({
	data,
}: NodeProps & { data: LensOverflowNodeData }) {
	return (
		<>
			<Ports />
			<div className="flex size-full items-center justify-center rounded-md border border-dashed border-border bg-background">
				<span className="font-mono text-[10px] text-muted-foreground">
					+{data.hidden} more {data.hidden === 1 ? "lens" : "lenses"}
				</span>
			</div>
		</>
	)
})

/**
 * A column heading — `FANNED OUT · 4 LENSES`. A node rather than an overlay so it
 * pans and zooms with the column it names; a heading that stays put while its
 * column slides out from under it is worse than none.
 */
export const FlowHeadingNode = memo(function FlowHeadingNode({
	data,
}: NodeProps & { data: { text: string } }) {
	return (
		<span
			className={cn(
				EYEBROW,
				"block whitespace-nowrap tracking-[0.1em] text-muted-foreground",
				"pointer-events-none text-[9px] leading-3",
			)}
		>
			{data.text}
		</span>
	)
})

/* -------------------------------------------------------------------------------------------------
 * Action
 * -----------------------------------------------------------------------------------------------*/

/**
 * One glyph per shape of work, deliberately monochrome.
 *
 * The spec reserves colour on this canvas for the amber "you are here" node and
 * the lens verdicts; nine tinted icons in the actions column would compete with
 * both. The glyph differentiates by shape alone, which is also what makes the
 * column scannable at the 0.7 zoom a narrow window forces.
 */
export const ACTION_GLYPH: Record<ActionKind, { Icon: IconComponent; label: string }> = {
	rollback: { Icon: RocketIcon, label: "Deploy or rollback" },
	alert: { Icon: BellIcon, label: "Alerting" },
	dashboard: { Icon: ChartBarIcon, label: "Dashboard" },
	traces: { Icon: NetworkNodesIcon, label: "Traces" },
	logs: { Icon: SquareTerminalIcon, label: "Logs" },
	issue: { Icon: AlertWarningIcon, label: "Error issue" },
	config: { Icon: SlidersIcon, label: "Configuration" },
	code: { Icon: CodeIcon, label: "Code change" },
	service: { Icon: ServerIcon, label: "Service setup" },
	task: { Icon: BoltIcon, label: "Action" },
}

function ActionGlyph({ kind }: { kind: ActionKind }) {
	const { Icon, label } = ACTION_GLYPH[kind]
	return (
		<span title={label} className="flex size-3.5 items-center justify-center text-muted-foreground">
			<Icon size={12} aria-label={label} />
		</span>
	)
}

/**
 * A proposed action the report has not written yet.
 *
 * Dashed, inert, and wordless. It keeps the actions column's gutter and its two
 * text rows so the real cards land in the same places these stood — the column
 * does not shift when the verdict arrives, it fills in.
 */
export const FlowActionGhostNode = memo(function FlowActionGhostNode() {
	return (
		<>
			<Ports />
			<div
				aria-hidden
				className="pointer-events-none flex size-full items-center gap-2.5 rounded-lg border border-dashed bg-card/40 px-3"
			>
				<span className="flex w-4 shrink-0 flex-col items-center gap-1.5 self-start pt-3">
					<Skeleton className="h-1.5 w-3 rounded-full" />
					<Skeleton className="size-3.5 rounded-sm" />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-1.5 py-2.5">
					<Skeleton className="h-2 w-full rounded-full" />
					<Skeleton className="h-2 w-2/3 rounded-full" />
					<Skeleton className="h-1.5 w-16 rounded-full" />
				</div>
			</div>
		</>
	)
})

export const FlowActionNode = memo(function FlowActionNode({ data }: NodeProps & { data: ActionNodeData }) {
	const open = () => data.onOpen?.(data.index)

	return (
		<>
			<Ports />
			{/*
			 * `role="button"` on a div rather than a real `<button>`: the CTA below is
			 * an `<a>`, and an anchor inside a button is invalid HTML. Same escape
			 * hatch — and same `closest("a")` guard — as the investigation table's
			 * clickable rows, so the CTA opens its page instead of the panel.
			 */}
			<div
				role="button"
				tabIndex={0}
				aria-label={`Proposed action ${data.ordinal}: ${data.text}`}
				onClick={(event) => {
					if ((event.target as HTMLElement).closest("a")) return
					open()
				}}
				onKeyDown={(event) => {
					if (event.key !== "Enter" && event.key !== " ") return
					if ((event.target as HTMLElement).closest("a")) return
					event.preventDefault()
					open()
				}}
				className="flex size-full cursor-pointer items-center gap-2.5 rounded-lg border bg-card px-3 transition-colors hover:border-primary/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
			>
				{/*
				 * A fixed-width gutter carrying both the rank and the shape of work:
				 * the ordinal is the order the report put them in, the glyph is what
				 * kind of thing it is asking for. Fixed width and always populated —
				 * `task` is a real kind — so the two lanes hold across every row.
				 */}
				<span className="flex w-4 shrink-0 flex-col items-center gap-1.5 self-start pt-3">
					<span className="font-mono text-[10px] leading-3 text-muted-foreground tabular-nums">
						{data.ordinal}
					</span>
					<ActionGlyph kind={data.kind} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-1.5 py-2.5">
					<p className="line-clamp-2 text-xs leading-[1.4] text-foreground">{data.text}</p>
					<p className="flex items-center gap-1.5">
						{data.target ? (
							<Link
								to={data.target.href}
								className="shrink-0 text-[9px] font-medium tracking-[0.06em] text-primary hover:underline"
							>
								{data.target.label} →
							</Link>
						) : null}
						{/*
						 * Spec rule 06: autofix and pull request are not nodes. They ride as a
						 * dim chip on the action they would perform — a roadmap promise
						 * attached to a real handle, not a placeholder box on the canvas.
						 */}
						<span className="min-w-0 flex-1 truncate text-right text-[9px] tracking-[0.06em] text-muted-foreground/60">
							{data.promise}
						</span>
					</p>
				</div>
			</div>
		</>
	)
})
