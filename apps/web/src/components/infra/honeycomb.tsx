import { useMemo, useRef, type ReactElement, type ReactNode } from "react"
import { cn } from "@maple/ui/lib/utils"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

import { useContainerSize } from "@maple/ui/hooks/use-container-size"

export type HoneycombTone = "ok" | "warn" | "crit" | "stale"

// The cell's flat fill (calm at rest, full tone on hover) derives from a single
// `--tone` color set per cell — see `.honeycomb-cell` in styles.css. Each tone
// just points `--tone` at its severity token.
const TONE_VAR: Record<HoneycombTone, string> = {
	ok: "var(--severity-info)",
	warn: "var(--severity-warn)",
	crit: "var(--severity-error)",
	stale: "var(--muted-foreground)",
}

// Flat fills for the small legend swatches (a clip-path hexagon can't carry a
// ring, so the hex cells themselves separate via the inter-cell gap).
export const CELL_BG: Record<HoneycombTone, string> = {
	ok: "bg-[var(--severity-info)]",
	warn: "bg-[var(--severity-warn)]",
	crit: "bg-[var(--severity-error)]",
	stale: "bg-[color-mix(in_oklab,var(--muted-foreground)_45%,var(--card))]",
}

export const CELL_RING: Record<HoneycombTone, string> = {
	ok: "ring-[color-mix(in_oklab,var(--severity-info)_30%,transparent)]",
	warn: "ring-[color-mix(in_oklab,var(--severity-warn)_35%,transparent)]",
	crit: "ring-[color-mix(in_oklab,var(--severity-error)_40%,transparent)]",
	stale: "ring-border/40",
}

const GLYPH_TONE: Record<HoneycombTone, string> = {
	ok: "text-background/90",
	warn: "text-background/90",
	crit: "text-background/90",
	stale: "text-foreground/70",
}

export interface HoneycombCell {
	key: string
	glyph: string
	tone: HoneycombTone
	/** A ready-built `<Link>` to the entity's detail page — the adapter owns the
	 *  typed route; Honeycomb only styles it into a hexagon. */
	link: ReactElement
	tooltip: ReactNode
}

// Pointy-top honeycomb geometry. Each cell occupies a `PITCH_X`-wide slot on a
// triangular lattice (every neighbour's centre is exactly PITCH_X away), and the
// visible hex is drawn `GAP` smaller than its slot. Because the hexes are
// regular and the lattice is uniform, that single inset yields an identical
// `GAP` of grout along *every* edge — horizontal and diagonal alike.
const HEX_RATIO = 2 / Math.sqrt(3) // height / width for a pointy-top hexagon
const HEX_W = 38 // drawn flat-to-flat width
const HEX_H = HEX_W * HEX_RATIO // drawn point-to-point height
const GAP = 3 // uniform grout between tiles
const PITCH_X = HEX_W + GAP // horizontal centre-to-centre distance
const PITCH_Y = PITCH_X * HEX_RATIO * 0.75 // vertical row pitch on the lattice
const ROW_MARGIN_TOP = PITCH_Y - HEX_H // negative: rows interlock
const ROW_OFFSET_X = PITCH_X / 2 // odd-row brick shift
const HEX_CLIP = "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)"

export function Honeycomb({ cells }: { cells: ReadonlyArray<HoneycombCell> }) {
	const ref = useRef<HTMLDivElement>(null)
	const { width } = useContainerSize(ref)

	// Reserve the odd-row offset so the brick shift never overflows the right edge.
	const cols = useMemo(() => {
		if (width <= 0) return 0
		return Math.max(1, Math.floor((width - ROW_OFFSET_X) / PITCH_X))
	}, [width])

	const rows = useMemo(() => {
		if (cols <= 0) return [] as HoneycombCell[][]
		const out: HoneycombCell[][] = []
		for (let i = 0; i < cells.length; i += cols) out.push(cells.slice(i, i + cols))
		return out
	}, [cells, cols])

	return (
		<TooltipProvider delay={80} closeDelay={0}>
			<div ref={ref} className="w-full">
				{rows.map((row, r) => (
					<div
						// Rows are positional (pure function of cols + order); keying by index
						// keeps them stable across re-sorts so only inner cells reconcile and
						// the honeycomb-in entrance doesn't replay.
						key={r}
						className="flex"
						style={{
							marginTop: r === 0 ? 0 : ROW_MARGIN_TOP,
							marginLeft: r % 2 === 1 ? ROW_OFFSET_X : 0,
						}}
					>
						{row.map((cell, c) => (
							<div
								key={cell.key}
								className="flex shrink-0 items-center justify-center"
								style={{ width: PITCH_X, height: HEX_H }}
							>
								<Tooltip>
									<TooltipTrigger
										render={cell.link}
										data-tone={cell.tone}
										className={cn(
											"honeycomb-cell group relative flex cursor-pointer items-center justify-center",
											"hover:z-10 hover:scale-[1.1]",
											"focus-visible:z-10 focus-visible:scale-[1.1] focus-visible:outline-none",
											"motion-reduce:hover:scale-100 motion-reduce:focus-visible:scale-100",
										)}
										style={{
											width: HEX_W,
											height: HEX_H,
											clipPath: HEX_CLIP,
											WebkitClipPath: HEX_CLIP,
											["--tone" as string]: TONE_VAR[cell.tone],
											animationDelay: `${Math.min((r * cols + c) * 4, 240)}ms`,
										}}
									>
										<span
											aria-hidden
											className={cn(
												"font-mono text-[9px] font-semibold uppercase tracking-tight opacity-0 transition-opacity duration-150",
												"group-hover:opacity-100 group-focus-visible:opacity-100",
												GLYPH_TONE[cell.tone],
											)}
										>
											{cell.glyph}
										</span>
									</TooltipTrigger>
									<TooltipContent side="top" className="space-y-1 text-xs">
										{cell.tooltip}
									</TooltipContent>
								</Tooltip>
							</div>
						))}
					</div>
				))}
			</div>
		</TooltipProvider>
	)
}

export interface HoneycombLegendItem {
	tone: HoneycombTone
	label: string
	count: number
}

interface HoneycombSectionProps {
	label: string
	count: number
	unit: string
	cells: ReadonlyArray<HoneycombCell>
	legend: ReadonlyArray<HoneycombLegendItem>
	footnote?: string
	actions?: ReactNode
}

/** Bordered card shared by all three honeycomb views: header (label + count +
 *  optional actions), the hex grid, and a legend footer. */
export function HoneycombSection({
	label,
	count,
	unit,
	cells,
	legend,
	footnote,
	actions,
}: HoneycombSectionProps) {
	return (
		<section aria-label={`${label} honeycomb`} className="rounded-md border bg-card">
			<div className="flex items-center justify-between gap-3 border-b px-4 py-2">
				<div className="flex items-baseline gap-3">
					<span className="text-[12px] font-medium text-foreground">{label}</span>
					<span className="text-[11px] tabular-nums text-muted-foreground">
						{count} {count === 1 ? unit : `${unit}s`}
					</span>
				</div>
				{actions}
			</div>

			<div className="overflow-hidden bg-background p-4">
				<Honeycomb cells={cells} />
			</div>

			<div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t px-4 py-2 text-[11px] text-muted-foreground">
				{legend.map((item) => (
					<LegendDot key={item.tone} tone={item.tone} label={item.label} count={item.count} />
				))}
				{footnote && <span className="ml-auto text-[10px] text-muted-foreground/60">{footnote}</span>}
			</div>
		</section>
	)
}

function LegendDot({ tone, label, count }: HoneycombLegendItem) {
	return (
		<span className="inline-flex items-center gap-1.5">
			<span className={cn("size-2 rounded-[2px] ring-1 ring-inset", CELL_BG[tone], CELL_RING[tone])} />
			<span>{label}</span>
			<span className="tabular-nums text-foreground/70">{count}</span>
		</span>
	)
}
