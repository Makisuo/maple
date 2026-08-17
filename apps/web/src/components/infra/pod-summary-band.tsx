// Fleet-shape band that sits above the pod list.
//
// It exists because the list alone can only ever tell you about the page you're
// looking at. The band answers the two questions the page can't: how big is the
// fleet really, and how much of it did my filters just hide. Every cell is a
// filter, so reading it and acting on it are the same gesture.
//
// Scope-only by design — it takes cluster/namespace/env but *not* the row
// filters, so the numbers stay stable while you narrow the table underneath.

import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import type { SeverityLevel } from "./format"

export interface PodScopeCounts {
	readonly totalPods: number
	readonly saturatedPods: number
	readonly elevatedPods: number
	readonly unboundedPods: number
	readonly stalePods: number
}

/** A one-click scope. `undefined` means "no scope" (the All cell). */
export type PodScope = "saturated" | "elevated" | "unbounded" | "stale"

interface PodSummaryBandProps {
	counts: PodScopeCounts
	activeScope?: PodScope
	onScopeChange: (scope: PodScope | undefined) => void
	waiting?: boolean
	className?: string
}

const SCOPE_TONE: Record<PodScope, SeverityLevel | "neutral"> = {
	saturated: "crit",
	elevated: "warn",
	unbounded: "warn",
	stale: "neutral",
} satisfies Record<PodScope, SeverityLevel | "neutral">

const VALUE_TONE: Record<SeverityLevel | "neutral", string> = {
	neutral: "text-foreground",
	ok: "text-foreground",
	warn: "text-[var(--severity-warn)]",
	crit: "text-[var(--severity-error)]",
} satisfies Record<SeverityLevel | "neutral", string>

interface ScopeCellProps {
	label: string
	hint: string
	value: number
	scope: PodScope
	active: boolean
	onSelect: (scope: PodScope | undefined) => void
}

function ScopeCell({ label, hint, value, scope, active, onSelect }: ScopeCellProps) {
	// A zero count is still worth showing — "0 saturated" is information — but it
	// isn't worth a colour, and pressing it would only produce an empty table.
	const tone = value > 0 ? SCOPE_TONE[scope] : "neutral"
	return (
		<button
			type="button"
			aria-pressed={active}
			disabled={value === 0}
			onClick={() => onSelect(active ? undefined : scope)}
			className={cn(
				"flex flex-1 flex-col justify-center gap-1.5 border-l px-4 py-3 text-left transition-colors",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
				value === 0 ? "cursor-default" : "hover:bg-muted/40",
				active && "bg-muted/60",
			)}
		>
			<span className="text-[11px] text-muted-foreground">{label}</span>
			<span className="flex items-baseline gap-1.5">
				<span
					className={cn(
						"font-mono text-xl font-semibold leading-none tabular-nums",
						value === 0 ? "text-muted-foreground" : VALUE_TONE[tone],
					)}
				>
					{value}
				</span>
				<span className="text-[10px] text-muted-foreground">{hint}</span>
			</span>
		</button>
	)
}

export function PodSummaryBand({
	counts,
	activeScope,
	onScopeChange,
	waiting,
	className,
}: PodSummaryBandProps) {
	const { totalPods, saturatedPods, elevatedPods, unboundedPods, stalePods } = counts
	const healthy = Math.max(totalPods - saturatedPods - elevatedPods, 0)

	// Proportional segments. A single saturated pod in a fleet of 600 is ~0.2% of
	// the width, which rounds to nothing — so any non-zero band gets a floor wide
	// enough to see and to click.
	const segments = (
		[
			{ key: "healthy", count: healthy, className: "bg-muted-foreground/35" },
			{ key: "elevated", count: elevatedPods, className: "bg-[var(--severity-warn)]" },
			{ key: "saturated", count: saturatedPods, className: "bg-[var(--severity-error)]" },
		] as const
	).filter((segment) => segment.count > 0)

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
						{totalPods.toLocaleString()}
					</span>
					<span className="text-[11px] text-muted-foreground">
						{totalPods === 1 ? "pod" : "pods"} in scope
					</span>
				</span>
				{totalPods > 0 ? (
					<div
						className="flex h-1.5 w-full gap-px overflow-hidden rounded-full"
						role="img"
						aria-label={`${healthy} healthy, ${elevatedPods} elevated, ${saturatedPods} saturated`}
					>
						{segments.map((segment) => (
							<div
								key={segment.key}
								className={segment.className}
								style={{ width: `${Math.max((segment.count / totalPods) * 100, 2)}%` }}
							/>
						))}
					</div>
				) : (
					<div className="h-1.5 w-full rounded-full bg-muted" />
				)}
				<span className="text-[10px] text-muted-foreground">
					share of the fleet by peak utilization
				</span>
			</div>
			<ScopeCell
				label="Saturated"
				hint="≥90%"
				value={saturatedPods}
				scope="saturated"
				active={activeScope === "saturated"}
				onSelect={onScopeChange}
			/>
			<ScopeCell
				label="Elevated"
				hint="≥60%"
				value={elevatedPods}
				scope="elevated"
				active={activeScope === "elevated"}
				onSelect={onScopeChange}
			/>
			<ScopeCell
				label="No limits set"
				hint="unbounded"
				value={unboundedPods}
				scope="unbounded"
				active={activeScope === "unbounded"}
				onSelect={onScopeChange}
			/>
			<ScopeCell
				label="Stale collector"
				hint=">5m"
				value={stalePods}
				scope="stale"
				active={activeScope === "stale"}
				onSelect={onScopeChange}
			/>
		</div>
	)
}

export function PodSummaryBandLoading() {
	return (
		<div className="flex flex-col border-b bg-background md:flex-row md:items-stretch">
			<div className="flex w-full flex-col justify-center gap-2 px-4 py-3 md:w-72 md:shrink-0">
				<Skeleton className="h-4 w-28" />
				<Skeleton className="h-1.5 w-full rounded-full" />
				<Skeleton className="h-2.5 w-40" />
			</div>
			{[0, 1, 2, 3].map((i) => (
				<div key={i} className="flex flex-1 flex-col justify-center gap-1.5 border-l px-4 py-3">
					<Skeleton className="h-3 w-20" />
					<Skeleton className="h-5 w-10" />
				</div>
			))}
		</div>
	)
}
