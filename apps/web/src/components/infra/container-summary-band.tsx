// Fleet-shape band above the container list — same contract as the pod band:
// scope-only inputs so the numbers stay stable while the table narrows, and
// every cell is a one-click filter. No "unbounded" cell — running without
// limits is the norm in plain Docker, so it isn't a signal there.

import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import type { SeverityLevel } from "./format"

export interface ContainerScopeCounts {
	readonly totalContainers: number
	readonly saturatedContainers: number
	readonly elevatedContainers: number
	readonly staleContainers: number
}

/** A one-click scope. `undefined` means "no scope" (the All cell). */
export type ContainerScope = "saturated" | "elevated" | "stale"

interface ContainerSummaryBandProps {
	counts: ContainerScopeCounts
	activeScope?: ContainerScope
	onScopeChange: (scope: ContainerScope | undefined) => void
	waiting?: boolean
	className?: string
}

const SCOPE_TONE: Record<ContainerScope, SeverityLevel | "neutral"> = {
	saturated: "crit",
	elevated: "warn",
	stale: "neutral",
} satisfies Record<ContainerScope, SeverityLevel | "neutral">

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
	scope: ContainerScope
	active: boolean
	onSelect: (scope: ContainerScope | undefined) => void
}

function ScopeCell({ label, hint, value, scope, active, onSelect }: ScopeCellProps) {
	// A zero count is still information, but pressing it would only produce an
	// empty table — see the pod band.
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

export function ContainerSummaryBand({
	counts,
	activeScope,
	onScopeChange,
	waiting,
	className,
}: ContainerSummaryBandProps) {
	const { totalContainers, saturatedContainers, elevatedContainers, staleContainers } = counts
	const healthy = Math.max(totalContainers - saturatedContainers - elevatedContainers, 0)

	// Proportional segments with a visible floor — see the pod band.
	const segments = (
		[
			{ key: "healthy", count: healthy, className: "bg-muted-foreground/35" },
			{ key: "elevated", count: elevatedContainers, className: "bg-[var(--severity-warn)]" },
			{ key: "saturated", count: saturatedContainers, className: "bg-[var(--severity-error)]" },
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
						{totalContainers.toLocaleString()}
					</span>
					<span className="text-[11px] text-muted-foreground">
						{totalContainers === 1 ? "container" : "containers"} in scope
					</span>
				</span>
				{totalContainers > 0 ? (
					<div
						className="flex h-1.5 w-full gap-px overflow-hidden rounded-full"
						role="img"
						aria-label={`${healthy} healthy, ${elevatedContainers} elevated, ${saturatedContainers} saturated`}
					>
						{segments.map((segment) => (
							<div
								key={segment.key}
								className={segment.className}
								style={{ width: `${Math.max((segment.count / totalContainers) * 100, 2)}%` }}
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
				value={saturatedContainers}
				scope="saturated"
				active={activeScope === "saturated"}
				onSelect={onScopeChange}
			/>
			<ScopeCell
				label="Elevated"
				hint="≥60%"
				value={elevatedContainers}
				scope="elevated"
				active={activeScope === "elevated"}
				onSelect={onScopeChange}
			/>
			<ScopeCell
				label="Stale agent"
				hint=">5m"
				value={staleContainers}
				scope="stale"
				active={activeScope === "stale"}
				onSelect={onScopeChange}
			/>
		</div>
	)
}

export function ContainerSummaryBandLoading() {
	return (
		<div className="flex flex-col border-b bg-background md:flex-row md:items-stretch">
			<div className="flex w-full flex-col justify-center gap-2 px-4 py-3 md:w-72 md:shrink-0">
				<Skeleton className="h-4 w-28" />
				<Skeleton className="h-1.5 w-full rounded-full" />
				<Skeleton className="h-2.5 w-40" />
			</div>
			{[0, 1, 2].map((i) => (
				<div key={i} className="flex flex-1 flex-col justify-center gap-1.5 border-l px-4 py-3">
					<Skeleton className="h-3 w-20" />
					<Skeleton className="h-5 w-10" />
				</div>
			))}
		</div>
	)
}
