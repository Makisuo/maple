import * as React from "react"
import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { SPARK_COLOR, VALUE_TONE, type Tone } from "../severity-tokens"

interface StatRailProps {
	children: React.ReactNode
	/** Columns at the `md` breakpoint (always 2-up below it). Defaults to 4. */
	columns?: 3 | 4
	className?: string
}

const COLUMNS_CLASS: Record<3 | 4, string> = {
	3: "md:grid-cols-3",
	4: "md:grid-cols-4",
} satisfies Record<3 | 4, string>

export function StatRail({ children, columns = 4, className }: StatRailProps) {
	return (
		<div
			className={cn(
				"grid grid-cols-2 divide-x divide-y divide-border rounded-md border bg-card md:divide-y-0",
				COLUMNS_CLASS[columns],
				className,
			)}
		>
			{children}
		</div>
	)
}

interface StatRailItemProps {
	eyebrow: string
	value: string
	tone?: Tone
	delta?: React.ReactNode
	/** Top-right slot, e.g. a link out. Takes precedence over `delta`. */
	action?: React.ReactNode
	spark?: ReadonlyArray<number>
	subline?: React.ReactNode
	delay?: number
	/** Drop the reserved sparkline slot so the value spans full width (dense grids with no sparks). */
	compact?: boolean
	/**
	 * Makes the tile a button. Given it, the tile also honours `selected` and
	 * `disabled`; without it the tile stays the plain readout every other rail
	 * renders, so no existing caller changes behaviour.
	 */
	onSelect?: () => void
	/** Only meaningful alongside `onSelect`. */
	selected?: boolean
	/** A tile with nothing to show: still rendered, but not selectable. */
	disabled?: boolean
	/** Extra classes on the tile shell, e.g. container-query padding overrides. */
	className?: string
	/** Extra classes on the value, e.g. a container-query size step-down. */
	valueClassName?: string
}

/**
 * The active-tile marker, built the same way the sidebar builds its own: a 2px
 * lane reserved on *every* tile, painted only on the selected one, with the
 * corner squared so it reads as a rule against the tile edge rather than a
 * rounded sliver floating inside it. Reserving the lane on all of them is what
 * keeps the contents from shifting sideways as the selection moves.
 *
 * See `ACTIVE_RAIL` in `components/dashboard/app-sidebar.tsx` — same idiom, one
 * level out.
 */
const RAIL_LANE = "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:transition-colors"

export function StatRailItem({
	eyebrow,
	value,
	tone = "neutral",
	delta,
	action,
	spark,
	subline,
	delay,
	compact,
	onSelect,
	selected,
	disabled,
	className,
	valueClassName,
}: StatRailItemProps) {
	const body = (
		<>
			<div className="flex items-baseline justify-between gap-3">
				<span
					className={cn(
						"truncate text-[11px] font-medium transition-colors",
						selected ? "text-primary" : "text-muted-foreground",
					)}
				>
					{eyebrow}
				</span>
				{action ??
					(delta ? (
						<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/80">
							{delta}
						</span>
					) : null)}
			</div>
			<div className="mt-2 flex items-end justify-between gap-3">
				{/* The value never wraps and never yields width; the sparkline gives way
				    instead. A two-line "12m 45s" pushes its whole row taller than the
				    tiles beside it, and the number is the thing the tile is for. */}
				<div
					className={cn(
						"shrink-0 whitespace-nowrap font-mono text-[26px] font-semibold tabular-nums leading-none tracking-[-0.01em]",
						VALUE_TONE[tone],
						valueClassName,
					)}
				>
					{value}
				</div>
				{spark && spark.length > 1 ? (
					<BarSpark
						values={spark.slice(-28)}
						color={SPARK_COLOR[tone]}
						className="h-7 w-24 min-w-0 shrink"
					/>
				) : compact ? null : (
					<div className="h-7 w-24 min-w-0 shrink" />
				)}
			</div>
			{subline ? (
				<div className="mt-2 truncate text-[11px] text-muted-foreground">{subline}</div>
			) : null}
		</>
	)

	const shell = cn("relative px-5 py-4 animate-in fade-in slide-in-from-bottom-1 duration-500", className)
	const style = delay ? { animationDelay: `${delay}ms`, animationFillMode: "backwards" } : undefined

	if (!onSelect) {
		return (
			<div className={shell} style={style}>
				{body}
			</div>
		)
	}

	return (
		<button
			type="button"
			disabled={disabled}
			aria-pressed={selected}
			onClick={onSelect}
			className={cn(
				shell,
				"w-full text-left",
				RAIL_LANE,
				selected ? "bg-muted/40 before:bg-primary" : "before:bg-transparent",
				disabled ? "cursor-default" : "cursor-pointer hover:bg-muted/25",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
			)}
			style={style}
		>
			{body}
		</button>
	)
}

/**
 * The ranked bar sparkline used inside a stat tile. Exported because the web
 * analytics KPI strip draws the same bars full-bleed along the bottom of its own
 * (selectable) tiles — same mark, different slot.
 */
export function BarSpark({
	values,
	color,
	className,
}: {
	values: ReadonlyArray<number>
	color: string
	className?: string
}) {
	if (!values.length) return <div className={className} />
	const max = Math.max(...values, 0.0001)
	const count = values.length
	const gap = 2
	const barWidth = Math.max((100 - gap * (count - 1)) / count, 0.5)
	return (
		<svg viewBox="0 0 100 100" preserveAspectRatio="none" className={className} aria-hidden>
			{values.map((v, i) => {
				const safe = Number.isFinite(v) && v >= 0 ? v : 0
				const ratio = max > 0 ? safe / max : 0
				const h = Math.max(ratio * 100, safe > 0 ? 5 : 0)
				const x = i * (barWidth + gap)
				const y = 100 - h
				return (
					<rect
						key={i}
						x={x}
						y={y}
						width={barWidth}
						height={h}
						rx={0}
						fill={color}
						opacity={0.3 + ratio * 0.7}
					/>
				)
			})}
		</svg>
	)
}

export function StatRailLoading() {
	return (
		<StatRail>
			{Array.from({ length: 4 }).map((_, i) => (
				<div key={i} className="px-5 py-4">
					<Skeleton className="h-3 w-16" />
					<div className="mt-3 flex items-end justify-between gap-3">
						<Skeleton className="h-7 w-20" />
						<Skeleton className="h-7 w-24" />
					</div>
					<Skeleton className="mt-3 h-3 w-32" />
				</div>
			))}
		</StatRail>
	)
}
