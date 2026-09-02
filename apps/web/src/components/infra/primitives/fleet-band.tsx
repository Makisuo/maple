// The fleet-shape band that sits above an infra list.
//
// A list can only ever tell you about the page you're looking at. The band
// answers the two questions the page can't: how big is the fleet really, and
// how much of it did my filters just hide. Every cell is a filter, so reading
// it and acting on it are the same gesture.
//
// This is the one implementation. It used to exist three times — pods, nodes,
// containers — each a verbatim copy with its own `ScopeCell`, and they had
// already drifted on whether a zeroed active cell could still be pressed. The
// caller now describes its fleet (the strip's segments, the cells, what they
// measure) and this draws it.

import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import type { Tone } from "../severity-tokens"

/** One slice of the proportional strip. */
export interface FleetBandSegment {
	readonly key: string
	readonly count: number
	/** A background class. */
	readonly className: string
}

/** One one-click scope. */
export interface FleetBandCell<S extends string> {
	readonly scope: S
	readonly label: string
	/** The threshold, in the cell's own words: "≥90%", "silent >5m". */
	readonly hint: string
	readonly value: number
	/** `info` is the freshness blue; the rest are the severity ramp. */
	readonly tone: Tone | "info"
}

interface FleetBandProps<S extends string> {
	total: number
	/** Singular, lower case: "pod", "node". */
	noun: string
	/** What the strip and cells actually measure — the band's honesty line. */
	caption: string
	segments: ReadonlyArray<FleetBandSegment>
	cells: ReadonlyArray<FleetBandCell<S>>
	activeScope?: S
	onScopeChange: (scope: S | undefined) => void
	waiting?: boolean
	className?: string
}

const CELL_VALUE_TONE: Record<Tone | "info", string> = {
	neutral: "text-foreground",
	ok: "text-foreground",
	info: "text-[var(--severity-info)]",
	warn: "text-[var(--severity-warn)]",
	crit: "text-[var(--severity-error)]",
} satisfies Record<Tone | "info", string>

export function FleetBand<S extends string>({
	total,
	noun,
	caption,
	segments,
	cells,
	activeScope,
	onScopeChange,
	waiting,
	className,
}: FleetBandProps<S>) {
	const drawn = segments.filter((segment) => segment.count > 0)

	return (
		<div
			className={cn(
				"flex flex-col border-b bg-background md:flex-row md:items-stretch",
				waiting && "opacity-60 transition-opacity",
				className,
			)}
		>
			<div className="flex w-full flex-col justify-center gap-2 px-4 py-3 md:w-72 md:shrink-0">
				<span className="flex items-baseline gap-1.5">
					<span className="font-mono text-base font-semibold tabular-nums">
						{total.toLocaleString()}
					</span>
					<span className="text-[11px] text-muted-foreground">
						{total === 1 ? noun : `${noun}s`} in scope
					</span>
				</span>
				{total > 0 ? (
					<div
						className="flex h-1.5 w-full gap-px overflow-hidden rounded-full"
						role="img"
						aria-label={segments.map((segment) => `${segment.count} ${segment.key}`).join(", ")}
					>
						{/* A single hot pod in a fleet of 600 is 0.2% of the width, which
						    rounds to nothing — so any non-zero segment gets a floor wide
						    enough to see. */}
						{drawn.map((segment) => (
							<div
								key={segment.key}
								className={segment.className}
								style={{ width: `${Math.max((segment.count / total) * 100, 2)}%` }}
							/>
						))}
					</div>
				) : (
					<div className="h-1.5 w-full rounded-full bg-muted" />
				)}
				<span className="text-[10px] text-muted-foreground">{caption}</span>
			</div>
			{cells.map((cell) => (
				<ScopeCell
					key={cell.scope}
					cell={cell}
					active={activeScope === cell.scope}
					onSelect={onScopeChange}
				/>
			))}
		</div>
	)
}

function ScopeCell<S extends string>({
	cell,
	active,
	onSelect,
}: {
	cell: FleetBandCell<S>
	active: boolean
	onSelect: (scope: S | undefined) => void
}) {
	const { scope, label, hint, value, tone } = cell
	// A zero is still information — "0 saturated" is worth saying — but it isn't
	// worth a colour, and pressing it would only produce an empty table. Unless
	// the scope is already active (a shared URL, a refresh that emptied it), in
	// which case the press is the only way back out.
	const idle = value === 0 && !active
	return (
		<button
			type="button"
			aria-pressed={active}
			disabled={idle}
			onClick={() => onSelect(active ? undefined : scope)}
			className={cn(
				"flex flex-1 flex-col justify-center gap-1.5 border-l px-4 py-3 text-left transition-colors",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
				idle ? "cursor-default" : "hover:bg-muted/40",
				active && "bg-muted/60",
			)}
		>
			<span className="text-[11px] text-muted-foreground">{label}</span>
			<span className="flex items-baseline gap-1.5">
				<span
					className={cn(
						"font-mono text-xl font-semibold leading-none tabular-nums",
						value === 0 ? "text-muted-foreground" : CELL_VALUE_TONE[tone],
					)}
				>
					{value}
				</span>
				<span className="text-[10px] text-muted-foreground">{hint}</span>
			</span>
		</button>
	)
}

export function FleetBandLoading({ cells }: { cells: number }) {
	return (
		<div className="flex flex-col border-b bg-background md:flex-row md:items-stretch">
			<div className="flex w-full flex-col justify-center gap-2 px-4 py-3 md:w-72 md:shrink-0">
				<Skeleton className="h-4 w-28" />
				<Skeleton className="h-1.5 w-full rounded-full" />
				<Skeleton className="h-2.5 w-40" />
			</div>
			{Array.from({ length: cells }, (_, i) => (
				<div key={i} className="flex flex-1 flex-col justify-center gap-1.5 border-l px-4 py-3">
					<Skeleton className="h-3 w-20" />
					<Skeleton className="h-5 w-10" />
				</div>
			))}
		</div>
	)
}
