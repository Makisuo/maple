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
	CircleQuestionIcon,
	CircleXmarkIcon,
	ClockIcon,
	CodeIcon,
	DotsIcon,
	EyeIcon,
	type IconComponent,
	MagnifierIcon,
	NetworkNodesIcon,
	RadioCheckedIcon,
	RocketIcon,
	ServerIcon,
	SlidersIcon,
	SpinnerIcon,
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
} satisfies Record<LensTone, string>

const TONE_BORDER: Record<LensTone, string> = {
	muted: "border-border",
	primary: "border-primary",
	success: "border-success",
	info: "border-info",
	warning: "border-warning",
	destructive: "border-destructive",
} satisfies Record<LensTone, string>

const GLYPH: Record<FlowGlyph, IconComponent> = {
	issue: AlertWarningIcon,
	check: RadioCheckedIcon,
	incident: BellIcon,
	investigation: MagnifierIcon,
	verdict: CircleCheckIcon,
} satisfies Record<FlowGlyph, IconComponent>

/**
 * One glyph per lane state, and only the running one is a loader.
 *
 * A queued lane and a reported lane both used to draw a stopped spinner, which
 * said "this component is broken" rather than "this lane is waiting". They now
 * split by what the lane is actually waiting on:
 *
 * - `queued` — nothing has happened. Bare dots, deliberately outside the circle
 *   family below: this lane has not entered the decision at all, which is the
 *   same thing its dashed border is saying.
 * - `reported` — the lane did its work and the answer is undecided. A question
 *   mark completes the circle vocabulary the settled states already speak in,
 *   sitting exactly between the tick and the cross.
 */
const LENS_GLYPH: Record<LensNodeData["state"]["icon"], IconComponent> = {
	queued: DotsIcon,
	running: SpinnerIcon,
	reported: CircleQuestionIcon,
	confirmed: EyeIcon,
	ruledOut: CircleXmarkIcon,
	deadline: ClockIcon,
	failed: CircleXmarkIcon,
} satisfies Record<LensNodeData["state"]["icon"], IconComponent>

/** The eyebrow strip: an icon in its tile, then the kind in caps. */
const EYEBROW = "text-[10px] font-medium uppercase tracking-[0.12em]"
/** Both handles are hidden — this graph is read-only, nothing connects to anything. */
const HANDLE = "!size-0 !min-h-0 !min-w-0 !border-0 !bg-transparent"

/**
 * The canvas's one live signal: an indeterminate bar in a visible track.
 *
 * Every node that is still working wears this and nothing else. The track is the
 * load-bearing half — a travelling mark on its own reads as a rendering artefact,
 * and the same mark inside a channel reads as progress — which is why this
 * replaced both the 1px full-bleed sweep the lens lanes used to draw along their
 * bottom border and the ring that used to expand out of the spine node's icon
 * tile. 3px rather than a hairline so it survives the 0.68 zoom a narrow window
 * forces, and so it is unmistakably a bar rather than a stray rule.
 *
 * Two placements, by what the bar belongs to. Inline (default) it sits in the
 * content stack directly under the line it annotates — the spine node's phase
 * row, where it is that stage's progress. `edge` pins it flush along the card's
 * bottom border, clipped into the card's own corner radius, for the lens lanes
 * and the pending verdict, which have no line for it to annotate: there it is
 * the card that is working. The inset rounded pill those two used to draw
 * belonged to neither, and floated.
 */
function LiveBar({ className, edge = false }: { className?: string; edge?: boolean }) {
	return (
		<span
			aria-hidden
			className={cn(
				"overflow-hidden bg-primary/20",
				edge
					? "absolute inset-x-0 bottom-0 h-[3px]"
					: "relative block h-[3px] w-full shrink-0 rounded-full",
				className,
			)}
		>
			<span
				className={cn(
					"provenance-progress-fill absolute inset-y-0 w-2/5 bg-primary",
					edge ? null : "rounded-full",
				)}
			/>
		</span>
	)
}

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
			{/*
			 * Directly under the phase line, so the stage and the fact that it is
			 * still moving are one block. In the gutter rather than on the border:
			 * a bar drawn on the card's edge was the thing that read as a hairline.
			 */}
			{data.live ? <LiveBar /> : null}
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
	/**
	 * The lane's own sentence, on the lane.
	 *
	 * Every card used to keep this row for a skeleton bar and put the sentence in a
	 * `title` tooltip — which meant a settled lane displayed a loading placeholder
	 * that would never resolve, and the fan read as a column of cards still
	 * fetching. A running lane says what it is doing, everyone else says what they
	 * found. The row is the same row either way.
	 */
	const line = running ? (data.progressNote ?? data.result) : data.result
	return (
		<>
			<Ports />
			<div
				className={cn(
					// `bg-card`, not `bg-background`: the canvas section is `bg-card/40`, so a
					// background-filled node punched a hole in it and read as a recess rather
					// than as a card sitting on one.
					"relative flex size-full flex-col justify-center gap-1 overflow-hidden rounded-md border bg-card px-2.5",
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
							// 1.1s, slower than Tailwind's 1s default: at 11px a faster
							// arc reads as a flicker rather than as a revolution.
							running
								? "animate-spin [animation-duration:1.1s] motion-reduce:animate-none"
								: null,
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
				{line ? (
					<p className="truncate text-[9px] leading-3 text-muted-foreground" title={line}>
						{line}
					</p>
				) : null}
				{/*
				 * On the card's bottom edge, not in the stack above it. As an inset
				 * rounded pill sitting in the content flow it belonged to nothing —
				 * a floating capsule with dead space under it — where flush against
				 * the border, clipped into the card's own corner radius, it reads as
				 * part of the card's frame. The 11px spinner stops being readable at
				 * the 0.68 zoom a narrow window forces; this does not.
				 */}
				{running ? <LiveBar edge /> : null}
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
				{/* On the bottom edge, like the lens lanes — this node is a card that is working, not a row with a bar in it. */}
				<LiveBar edge />
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
} satisfies Record<ActionKind, { Icon: IconComponent; label: string }>

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
