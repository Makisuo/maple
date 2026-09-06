import { cn } from "@maple/ui/lib/utils"

import type { ReleaseHealth } from "./release-model"

export const RELEASE_HEALTH_LABEL = {
	regressed: "errors up",
	watch: "latency up",
	rolling: "rolling out",
	healthy: "healthy",
} satisfies Record<ReleaseHealth, string>

export const RELEASE_HEALTH_DESCRIPTION = {
	regressed: "Errors at least twice as often as the other versions of the same service in this window.",
	watch: "p95 latency up by a quarter or more against the other versions of the same service.",
	rolling: "The newest version of its service, not yet carrying the whole of the latest traffic.",
	healthy: "No change worth flagging against the other versions of the same service.",
} satisfies Record<ReleaseHealth, string>

/** Marker fill for the swimlanes and the filter legend. */
export const RELEASE_HEALTH_DOT_CLASS = {
	regressed: "bg-destructive",
	watch: "bg-severity-warn",
	rolling: "border-2 border-primary bg-background",
	healthy: "bg-primary/70",
} satisfies Record<ReleaseHealth, string>

const PILL_CLASS = {
	regressed: "bg-destructive/10 text-destructive",
	watch: "bg-severity-warn/15 text-severity-warn",
	rolling: "bg-primary/10 text-primary",
	healthy: "bg-muted text-muted-foreground",
} satisfies Record<ReleaseHealth, string>

interface ReleaseHealthPillProps {
	health: ReleaseHealth
	/** Replaces the generic label with the measured figure ("errors 4.1×", "p95 +38%"). */
	label?: string
	className?: string
}

export function ReleaseHealthPill({ health, label, className }: ReleaseHealthPillProps) {
	return (
		<span
			title={RELEASE_HEALTH_DESCRIPTION[health]}
			className={cn(
				"inline-flex h-[18px] shrink-0 cursor-default items-center rounded-full px-1.5 font-mono text-[10px] tabular-nums leading-none",
				PILL_CLASS[health],
				className,
			)}
		>
			{label ?? RELEASE_HEALTH_LABEL[health]}
		</span>
	)
}

/** "errors 4.1×" / "p95 +38%" / "42% rolling out" — the figure behind the band. */
export function releaseHealthFigure(impact: {
	health: ReleaseHealth
	errorRatio: number | undefined
	p95Delta: number | undefined
	share: number | undefined
}): string | undefined {
	switch (impact.health) {
		case "regressed":
			return impact.errorRatio === undefined
				? undefined
				: Number.isFinite(impact.errorRatio)
					? `errors ${impact.errorRatio.toFixed(1)}×`
					: "errors from 0"
		case "watch":
			return impact.p95Delta === undefined ? undefined : `p95 +${Math.round(impact.p95Delta * 100)}%`
		case "rolling":
			return impact.share === undefined ? undefined : `${Math.round(impact.share * 100)}% rolling out`
		case "healthy":
			return undefined
	}
}
