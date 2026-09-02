// The container list's fleet band — the pod band's shape on `FleetBand`, with
// no "unbounded" cell: running without limits is the norm in plain Docker, so
// it isn't a signal there.

import { FleetBand, FleetBandLoading } from "./primitives/fleet-band"

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

export function ContainerSummaryBand({
	counts,
	activeScope,
	onScopeChange,
	waiting,
	className,
}: ContainerSummaryBandProps) {
	const { totalContainers, saturatedContainers, elevatedContainers, staleContainers } = counts
	const healthy = Math.max(totalContainers - saturatedContainers - elevatedContainers, 0)

	return (
		<FleetBand<ContainerScope>
			total={totalContainers}
			noun="container"
			caption="share of the fleet by peak utilization"
			segments={[
				{ key: "healthy", count: healthy, className: "bg-muted-foreground/35" },
				{ key: "elevated", count: elevatedContainers, className: "bg-[var(--severity-warn)]" },
				{ key: "saturated", count: saturatedContainers, className: "bg-[var(--severity-error)]" },
			]}
			cells={[
				{
					scope: "saturated",
					label: "Saturated",
					hint: "≥90%",
					value: saturatedContainers,
					tone: "crit",
				},
				{
					scope: "elevated",
					label: "Elevated",
					hint: "≥60%",
					value: elevatedContainers,
					tone: "warn",
				},
				{
					scope: "stale",
					label: "Stale agent",
					hint: ">5m",
					value: staleContainers,
					tone: "neutral",
				},
			]}
			activeScope={activeScope}
			onScopeChange={onScopeChange}
			waiting={waiting}
			className={className}
		/>
	)
}

export function ContainerSummaryBandLoading() {
	return <FleetBandLoading cells={3} />
}
