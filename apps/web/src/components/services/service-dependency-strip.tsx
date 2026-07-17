import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import { cn } from "@maple/ui/utils"

import { Result } from "@/lib/effect-atom"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { getServiceDependenciesBundleResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { DatabaseIcon, GlobeIcon, NetworkNodesIcon, PaperPlaneIcon } from "@/components/icons"
import type { DependencyKind } from "./dependency-type-badge"

const STRIP_LIMIT = 8

interface ServiceDependencyStripProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	/** Switches the page to the Dependencies tab (URL-driven). */
	onViewAll: () => void
}

interface StripTarget {
	id: string
	kind: DependencyKind
	name: string
	estimatedCalls: number
}

const KIND_ICON: Record<Exclude<DependencyKind, "service">, typeof DatabaseIcon> = {
	database: DatabaseIcon,
	http: GlobeIcon,
	messaging: PaperPlaneIcon,
	rpc: NetworkNodesIcon,
}

/**
 * "Talks to" strip: the service's busiest downstream targets as one quiet row of
 * chips under the charts. Reads the same dependencies bundle the Dependencies
 * tab fetches (same atom key), so opening that tab afterwards is a cache hit.
 */
export function ServiceDependencyStrip({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	onViewAll,
}: ServiceDependencyStripProps) {
	const bundleResult = useRetainedRefreshableResultValue(
		getServiceDependenciesBundleResultAtom({
			data: { serviceName, startTime: effectiveStartTime, endTime: effectiveEndTime },
		}),
	)

	const targets = useMemo<StripTarget[]>(() => {
		return Result.builder(bundleResult)
			.onSuccess((bundle) => {
				const out: StripTarget[] = []
				for (const edge of bundle.serviceEdges) {
					if (!edge.targetService) continue
					out.push({
						id: `service:${edge.targetService}`,
						kind: "service",
						name: edge.targetService,
						estimatedCalls: edge.estimatedCallCount,
					})
				}
				for (const edge of bundle.dbEdges) {
					if (!edge.dbSystem) continue
					out.push({
						id: `database:${edge.dbSystem}:${edge.dbNamespace}`,
						kind: "database",
						name: edge.dbNamespace ? `${edge.dbSystem} · ${edge.dbNamespace}` : edge.dbSystem,
						estimatedCalls: edge.estimatedCallCount,
					})
				}
				for (const edge of bundle.externalEdges) {
					if (!edge.targetName) continue
					out.push({
						id: `${edge.targetType}:${edge.targetName}`,
						kind: edge.targetType,
						name: edge.targetName,
						estimatedCalls: edge.estimatedCallCount,
					})
				}
				return out.toSorted((a, b) => b.estimatedCalls - a.estimatedCalls)
			})
			.orElse(() => [])
	}, [bundleResult])

	// Quiet by design: while loading or when the service has no observed
	// downstream calls, the strip simply doesn't render — it's context, not a
	// primary surface, and an empty shell here would just be noise.
	if (targets.length === 0) return null

	const visible = targets.slice(0, STRIP_LIMIT)
	const hiddenCount = targets.length - visible.length
	const isWaiting = Result.isSuccess(bundleResult) && bundleResult.waiting

	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-x-2 gap-y-1.5 transition-opacity",
				isWaiting && "opacity-60",
			)}
		>
			<span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Talks to</span>
			{visible.map((target) =>
				target.kind === "service" ? (
					<Link
						key={target.id}
						to="/services/$serviceName"
						params={{ serviceName: target.name }}
						className="inline-flex max-w-[220px] items-center gap-1.5 rounded-md border bg-card px-2 py-0.5 text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						<ServiceDot serviceName={target.name} />
						<span className="truncate">{target.name}</span>
					</Link>
				) : (
					<DependencyChip key={target.id} target={target} onClick={onViewAll} />
				),
			)}
			{hiddenCount > 0 ? (
				<button
					type="button"
					onClick={onViewAll}
					className="inline-flex items-center rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					+{hiddenCount} more
				</button>
			) : null}
			<button
				type="button"
				onClick={onViewAll}
				className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			>
				View all →
			</button>
		</div>
	)
}

function DependencyChip({ target, onClick }: { target: StripTarget; onClick: () => void }) {
	const Icon = KIND_ICON[target.kind === "service" ? "http" : target.kind]
	return (
		<button
			type="button"
			onClick={onClick}
			className="inline-flex max-w-[220px] items-center gap-1.5 rounded-md border bg-card px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			title={`${target.name} — see Dependencies tab`}
		>
			<Icon size={11} />
			<span className="truncate">{target.name}</span>
		</button>
	)
}
