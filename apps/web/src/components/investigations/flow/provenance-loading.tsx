/**
 * The provenance canvas before it has anything to draw.
 *
 * Rather than a grey block standing in for the page's lead widget, this previews
 * the destination: the same left-to-right chain — spine, lens fan, verdict,
 * proposed actions — as ghost cards that assemble on the same column grid the
 * real graph uses, wired by the same square-cornered strands.
 *
 * Inline SVG on the real graph's 1270-wide frame, for the reason
 * `service-map-loading.tsx` is: it scales to any pane with no measurement pass,
 * themes through CSS variables, and settles to a static graph under
 * `prefers-reduced-motion` (gated in `styles.css`).
 *
 * Nothing here carries a word. A ghost card says "a card lands here"; a ghost
 * card with text on it would be stating a finding the investigation has not made
 * — the same rule `PendingVerdictNodeData` is written to.
 */
import type { CSSProperties } from "react"

import { ACTION_WIDTH, LENS_WIDTH, SPINE_WIDTH } from "./provenance-graph"

/* The real graph's geometry. The widths are imported; the rest is the private
   arithmetic of `provenance-graph.ts`, mirrored rather than exported — the ghost
   is decorative and must not become a second consumer of the layout math. */
const GUTTER = 52
const SPINE_H = 128
const SPINE_H_LIVE = 148
const LENS_H = 64
const LENS_GAP = 8
const ACTION_H = 76
const ACTION_GAP = 8
/** Column headings ride 20px above their column's top edge. */
const HEADING_OFFSET = 20

/**
 * Six columns on 198px origins — issue, incident, investigation, the lens fan,
 * the verdict, the proposed actions — which is the widest chain the real builder
 * emits and lands on its 1270 frame.
 */
const COLUMN_X = [0, 1, 2, 3, 4, 5].map((i) => i * (SPINE_WIDTH + GUTTER))
const GRAPH_W = COLUMN_X[5] + ACTION_WIDTH
/** The tallest column sets the frame; every other column centres against it. */
const GRAPH_H = LENS_H * 3 + LENS_GAP * 2

const top = (height: number) => (GRAPH_H - height) / 2

type Card = { x: number; y: number; w: number; h: number; r: number }

const spineCard = (column: number, h: number): Card => ({
	x: COLUMN_X[column],
	y: top(h),
	w: SPINE_WIDTH,
	h,
	r: 8,
})

/** The three causal steps: what happened, where, and the run itself. */
const SPINE: Array<Card> = [spineCard(0, SPINE_H), spineCard(1, SPINE_H), spineCard(2, SPINE_H_LIVE)]
const LENSES: Array<Card> = [0, 1, 2].map((i) => ({
	x: COLUMN_X[3],
	y: i * (LENS_H + LENS_GAP),
	w: LENS_WIDTH,
	h: LENS_H,
	r: 6,
}))
const VERDICT: Card = spineCard(4, SPINE_H)
const ACTIONS: Array<Card> = [0, 1].map((i) => ({
	x: COLUMN_X[5],
	y: top(ACTION_H * 2 + ACTION_GAP) + i * (ACTION_H + ACTION_GAP),
	w: ACTION_WIDTH,
	h: ACTION_H,
	r: 8,
}))

const right = (c: Card) => ({ x: c.x + c.w, y: c.y + c.h / 2 })
const left = (c: Card) => ({ x: c.x, y: c.y + c.h / 2 })

/**
 * A square-cornered hop with the corners softened, matching xyflow's
 * `getSmoothStepPath({ borderRadius: 8, offset: 16 })`. A curved ghost strand
 * that pops into an orthogonal real one reads as two different graphs.
 */
function stepPath(a: { x: number; y: number }, b: { x: number; y: number }) {
	if (Math.abs(a.y - b.y) < 0.5) return `M${a.x},${a.y} H${b.x}`
	const mid = (a.x + b.x) / 2
	const r = 8
	const down = b.y > a.y ? 1 : -1
	return [
		`M${a.x},${a.y}`,
		`H${mid - r}`,
		`Q${mid},${a.y} ${mid},${a.y + down * r}`,
		`V${b.y - down * r}`,
		`Q${mid},${b.y} ${mid + r},${b.y}`,
		`H${b.x}`,
	].join(" ")
}

const STRANDS: Array<{ d: string; dash: string }> = [
	{ d: stepPath(right(SPINE[0]), left(SPINE[1])), dash: "3 3" },
	{ d: stepPath(right(SPINE[1]), left(SPINE[2])), dash: "3 3" },
	// Fan out into the lanes, merge back into the verdict, then the roadmap hop.
	...LENSES.map((lens) => ({ d: stepPath(right(SPINE[2]), left(lens)), dash: "3 3" })),
	...LENSES.map((lens) => ({ d: stepPath(right(lens), left(VERDICT)), dash: "3 3" })),
	...ACTIONS.map((action) => ({ d: stepPath(right(VERDICT), left(action)), dash: "4 4" })),
]

/** The junction dots the real strands cap themselves with. */
const PORTS = [
	right(SPINE[0]),
	left(SPINE[1]),
	right(SPINE[1]),
	left(SPINE[2]),
	right(SPINE[2]),
	...LENSES.flatMap((c) => [left(c), right(c)]),
	left(VERDICT),
	right(VERDICT),
	...ACTIONS.map((c) => left(c)),
]

const BAR = "var(--muted-foreground)"

/** A placeholder row. `breathe` marks the one bar per card that keeps moving. */
function Bar({
	x,
	y,
	w,
	h = 5,
	opacity = 0.2,
	breathe,
	delay,
}: {
	x: number
	y: number
	w: number
	h?: number
	opacity?: number
	breathe?: boolean
	delay?: number
}) {
	return (
		<rect
			x={x}
			y={y}
			width={w}
			height={h}
			rx={h / 2}
			fill={BAR}
			opacity={opacity}
			className={breathe ? "provenance-load-bar" : undefined}
			style={breathe ? ({ animationDelay: `${delay ?? 0}s` } as CSSProperties) : undefined}
		/>
	)
}

/** A spine card: glyph tile, eyebrow, two title rows, a timestamp along the bottom. */
function SpineGhost({ card, delay }: { card: Card; delay: number }) {
	const { x, y, w, h } = card
	return (
		<g className="provenance-load-node" style={{ animationDelay: `${delay}s` } as CSSProperties}>
			<rect
				x={x}
				y={y}
				width={w}
				height={h}
				rx={card.r}
				fill="var(--card)"
				stroke="var(--border)"
				strokeWidth={1}
			/>
			<rect x={x + 12} y={y + 10} width={22} height={22} rx={4} fill="var(--muted)" />
			<Bar x={x + 40} y={y + 18} w={62} opacity={0.28} />
			<Bar x={x + 12} y={y + 44} w={w - 24} h={6} breathe delay={delay} />
			<Bar x={x + 12} y={y + 58} w={(w - 24) * 0.62} h={6} opacity={0.16} />
			<Bar x={x + 12} y={y + h - 18} w={44} opacity={0.14} />
		</g>
	)
}

/** A lens lane: title, then the state row — glyph, word, elapsed. */
function LensGhost({ card, delay }: { card: Card; delay: number }) {
	const { x, y, w, h } = card
	return (
		<g className="provenance-load-node" style={{ animationDelay: `${delay}s` } as CSSProperties}>
			<rect
				x={x}
				y={y}
				width={w}
				height={h}
				rx={card.r}
				fill="var(--background)"
				stroke="var(--border)"
				strokeWidth={1}
			/>
			<Bar x={x + 10} y={y + 14} w={w - 40} h={5.5} breathe delay={delay} />
			<circle cx={x + 15.5} cy={y + 39} r={5.5} fill={BAR} opacity={0.22} />
			<Bar x={x + 26} y={y + 36.5} w={36} opacity={0.22} />
			<Bar x={x + w - 32} y={y + 36.5} w={22} opacity={0.14} />
		</g>
	)
}

/** A proposed action: the fixed ordinal/glyph gutter, two text rows, a chip. */
function ActionGhost({ card, delay }: { card: Card; delay: number }) {
	const { x, y, w, h } = card
	return (
		<g className="provenance-load-node" style={{ animationDelay: `${delay}s` } as CSSProperties}>
			<rect
				x={x}
				y={y}
				width={w}
				height={h}
				rx={card.r}
				fill="var(--card)"
				stroke="var(--border)"
				strokeWidth={1}
			/>
			<Bar x={x + 12} y={y + 14} w={12} opacity={0.24} />
			<rect x={x + 11} y={y + 26} width={14} height={14} rx={3} fill={BAR} opacity={0.16} />
			<Bar x={x + 34} y={y + 18} w={w - 60} h={6} breathe delay={delay} />
			<Bar x={x + 34} y={y + 32} w={(w - 60) * 0.66} h={6} opacity={0.16} />
			<Bar x={x + 34} y={y + h - 20} w={56} opacity={0.14} />
		</g>
	)
}

/**
 * The loading canvas.
 *
 * Wears the same section shell and caption row as `ProvenanceCanvas`, so the real
 * graph swaps in underneath without the page moving. The caption's two labels are
 * the widget's own name, not a finding, so they can be printed for real.
 */
export function ProvenanceCanvasLoading() {
	const cards = [
		...SPINE.map((card, i) => ({ kind: "spine" as const, card, delay: i * 0.08 })),
		...LENSES.map((card, i) => ({ kind: "lens" as const, card, delay: 0.26 + i * 0.07 })),
		{ kind: "spine" as const, card: VERDICT, delay: 0.5 },
		...ACTIONS.map((card, i) => ({ kind: "action" as const, card, delay: 0.58 + i * 0.07 })),
	]

	return (
		<section
			className="flex shrink-0 flex-col gap-3.5 rounded-lg border bg-card/40 px-6 pb-5.5 pt-4.5"
			aria-busy
		>
			<div className="flex items-center gap-2.5">
				<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
					Provenance
				</span>
				<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
					what produced this investigation, and what it produced
				</span>
				<span className="flex shrink-0 items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-muted-foreground">
					<span>Mapping the chain</span>
					<span className="inline-flex" aria-hidden>
						<span className="pulse-dot">.</span>
						<span className="pulse-dot">.</span>
						<span className="pulse-dot">.</span>
					</span>
				</span>
			</div>

			<svg
				viewBox={`0 ${-HEADING_OFFSET - 12} ${GRAPH_W} ${GRAPH_H + HEADING_OFFSET + 24}`}
				className="h-auto w-full"
				role="img"
				aria-label="Loading the provenance graph"
				fill="none"
			>
				{/* Column headings — the fan and the actions column each carry one. */}
				<Bar x={COLUMN_X[3]} y={-HEADING_OFFSET - 5} w={96} opacity={0.16} />
				<Bar x={COLUMN_X[5]} y={-HEADING_OFFSET - 5} w={128} opacity={0.16} />

				{STRANDS.map((strand, i) => (
					<path
						key={`strand-${i}`}
						className="provenance-load-strand"
						style={{ animationDelay: `${0.12 + i * 0.05}s` } as CSSProperties}
						d={strand.d}
						stroke="var(--muted-foreground)"
						strokeOpacity={0.45}
						strokeWidth={1}
						strokeDasharray={strand.dash}
					/>
				))}
				{PORTS.map((port, i) => (
					<circle
						key={`port-${i}`}
						className="provenance-load-strand"
						style={{ animationDelay: `${0.12 + i * 0.03}s` } as CSSProperties}
						cx={port.x}
						cy={port.y}
						r={2.5}
						fill={BAR}
						opacity={0.5}
					/>
				))}

				{cards.map(({ kind, card, delay }, i) =>
					kind === "spine" ? (
						<SpineGhost key={`card-${i}`} card={card} delay={delay} />
					) : kind === "lens" ? (
						<LensGhost key={`card-${i}`} card={card} delay={delay} />
					) : (
						<ActionGhost key={`card-${i}`} card={card} delay={delay} />
					),
				)}
			</svg>
		</section>
	)
}
