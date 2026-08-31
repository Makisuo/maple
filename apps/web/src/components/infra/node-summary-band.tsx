// Fleet-shape band above the node list — the node counterpart to
// `PodSummaryBand`, and the replacement for the honeycomb.
//
// The honeycomb spent ~150px drawing one hexagon per node, coloured by the same
// three states this band names in a 6px strip. At 58 nodes it was a wall of
// grey that answered "how many are quiet?" only by counting cells, and it could
// not be acted on — you read it, then went and typed in the search box. Every
// cell here is a filter, so reading it and acting on it are one gesture.
//
// The states are collector freshness, not Kubernetes conditions: a node is
// "Down" here when no kubelet metric has arrived recently, which is a fact
// about the collector as much as about the node. `k8s.node.condition_ready` is
// collected but unqueried — when it lands, it belongs beside these, not
// instead of them.

import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import type { HostStatus } from "./format"
import { statusLabel } from "./severity-tokens"

export interface NodeStatusCounts {
	readonly total: number
	readonly active: number
	readonly idle: number
	readonly down: number
}

interface NodeSummaryBandProps {
	counts: NodeStatusCounts
	activeScope?: HostStatus
	onScopeChange: (scope: HostStatus | undefined) => void
	waiting?: boolean
	className?: string
}

const SCOPE_VALUE_TONE: Record<HostStatus, string> = {
	active: "text-[var(--severity-info)]",
	idle: "text-[var(--severity-warn)]",
	down: "text-[var(--severity-error)]",
} satisfies Record<HostStatus, string>

const SCOPE_SEGMENT: Record<HostStatus, string> = {
	active: "bg-[var(--severity-info)]",
	idle: "bg-[var(--severity-warn)]",
	down: "bg-[var(--severity-error)]",
} satisfies Record<HostStatus, string>

/** What each state actually means, since "Down" is a claim worth qualifying. */
const SCOPE_HINT: Record<HostStatus, string> = {
	active: "reporting",
	idle: "quiet >1m",
	down: "silent >5m",
} satisfies Record<HostStatus, string>

const SCOPES: ReadonlyArray<HostStatus> = ["active", "idle", "down"]

export function NodeSummaryBand({
	counts,
	activeScope,
	onScopeChange,
	waiting,
	className,
}: NodeSummaryBandProps) {
	// A single quiet node in a fleet of 200 is 0.5% of the width, which rounds to
	// nothing — so any non-zero segment gets a floor wide enough to see.
	const segments = SCOPES.map((status) => ({ status, count: counts[status] })).filter(
		(segment) => segment.count > 0,
	)

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
						{counts.total.toLocaleString()}
					</span>
					<span className="text-[11px] text-muted-foreground">
						{counts.total === 1 ? "node" : "nodes"} in scope
					</span>
				</span>
				{counts.total > 0 ? (
					<div
						className="flex h-1.5 w-full gap-px overflow-hidden rounded-full"
						role="img"
						aria-label={SCOPES.map((s) => `${counts[s]} ${statusLabel(s)}`).join(", ")}
					>
						{segments.map((segment) => (
							<div
								key={segment.status}
								className={SCOPE_SEGMENT[segment.status]}
								style={{ width: `${Math.max((segment.count / counts.total) * 100, 2)}%` }}
							/>
						))}
					</div>
				) : (
					<div className="h-1.5 w-full rounded-full bg-muted" />
				)}
				<span className="text-[10px] text-muted-foreground">
					share of the fleet by collector freshness
				</span>
			</div>
			{SCOPES.map((status) => (
				<ScopeCell
					key={status}
					status={status}
					value={counts[status]}
					active={activeScope === status}
					onSelect={onScopeChange}
				/>
			))}
		</div>
	)
}

function ScopeCell({
	status,
	value,
	active,
	onSelect,
}: {
	status: HostStatus
	value: number
	active: boolean
	onSelect: (scope: HostStatus | undefined) => void
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			disabled={value === 0}
			onClick={() => onSelect(active ? undefined : status)}
			className={cn(
				"flex flex-1 flex-col justify-center gap-1.5 border-l px-4 py-3 text-left transition-colors",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
				value === 0 ? "cursor-default" : "hover:bg-muted/40",
				active && "bg-muted/60",
			)}
		>
			<span className="text-[11px] text-muted-foreground">{statusLabel(status)}</span>
			<span className="flex items-baseline gap-1.5">
				{/* A zero is still information — "0 down" is worth saying — but it
				    isn't worth a colour, and pressing it would only empty the table. */}
				<span
					className={cn(
						"font-mono text-xl font-semibold leading-none tabular-nums",
						value === 0 ? "text-muted-foreground" : SCOPE_VALUE_TONE[status],
					)}
				>
					{value}
				</span>
				<span className="text-[10px] text-muted-foreground">{SCOPE_HINT[status]}</span>
			</span>
		</button>
	)
}

export function NodeSummaryBandLoading() {
	return (
		<div className="flex flex-col border-b bg-background md:flex-row md:items-stretch">
			<div className="flex w-full flex-col justify-center gap-2 px-4 py-3 md:w-72 md:shrink-0">
				<Skeleton className="h-4 w-28" />
				<Skeleton className="h-1.5 w-full" />
				<Skeleton className="h-2.5 w-44" />
			</div>
			{SCOPES.map((status) => (
				<div key={status} className="flex flex-1 flex-col justify-center gap-1.5 border-l px-4 py-3">
					<Skeleton className="h-3 w-14" />
					<Skeleton className="h-5 w-10" />
				</div>
			))}
		</div>
	)
}
