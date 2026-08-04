import { useState } from "react"
import { Link } from "@tanstack/react-router"

import { cn } from "@maple/ui/lib/utils"

import type { PlanetScaleScrapeTargetSummary } from "@maple/domain/http"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { metricsHealthState, type MetricsAuth, type MetricsHealthState } from "./planetscale-setup-steps"

/**
 * Outcome-level health for the managed branch-metrics collection. Collection
 * itself is fully automatic (Maple provisions and runs it), so the card shows a
 * single status row instead of the underlying machinery: one dot, one label,
 * and — only when degraded — the raw error behind a disclosure.
 *
 * The state comes from {@link metricsHealthState}, shared with the setup
 * checklist, so this row and the checklist can never disagree about whether
 * metrics are flowing.
 */
export function PlanetScaleMetricsHealth({
	target,
	metricsAuth,
	action,
}: {
	target: PlanetScaleScrapeTargetSummary
	metricsAuth: MetricsAuth
	/** Trailing affordance (e.g. Rotate token) rendered at the end of the row. */
	action?: React.ReactNode
}) {
	const [detailsOpen, setDetailsOpen] = useState(false)

	const state = metricsHealthState(target, metricsAuth, Date.now())
	// The token-setup step owns the missing-auth state — don't show two messages.
	if (state === "unconfigured") return null

	const updatedAgo =
		target.lastScrapeAt !== null ? formatRelativeTime(new Date(target.lastScrapeAt).toISOString()) : null

	return (
		<div className="border-t border-border/60 p-4">
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<span
					aria-hidden
					className={cn(
						"size-1.5 shrink-0 rounded-full",
						state === "healthy" && "bg-severity-info",
						state === "waiting" && "animate-pulse bg-muted-foreground/60",
						(state === "degraded" || state === "stalled") && "bg-severity-warn",
					)}
				/>
				<span className="font-medium text-foreground">{HEADLINE[state]}</span>
				<span className="text-muted-foreground">
					{state === "waiting"
						? "Branch metrics usually appear within a minute."
						: state === "healthy"
							? `Updated ${updatedAgo}`
							: updatedAgo !== null
								? `Last data ${updatedAgo}`
								: null}
					{state === "healthy" && target.excludeBranches.length > 0 ? (
						<> · excluding {target.excludeBranches.join(", ")}</>
					) : null}
				</span>
				{/* The payoff link: the point of finishing setup is the fleet page. */}
				{state === "healthy" ? (
					<Link
						to="/infra/planetscale"
						className="text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
					>
						View databases
					</Link>
				) : null}
				<div className="ml-auto flex items-center gap-2">
					{state === "degraded" ? (
						<button
							type="button"
							onClick={() => setDetailsOpen((open) => !open)}
							className="text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
						>
							{detailsOpen ? "Hide details" : "Show details"}
						</button>
					) : null}
					{action}
				</div>
			</div>
			{state === "degraded" && detailsOpen ? (
				<p className="mt-2 break-all rounded-md bg-muted/40 p-2 font-mono text-xs text-muted-foreground">
					{target.lastScrapeError}
				</p>
			) : null}
		</div>
	)
}

const HEADLINE: Record<MetricsHealthState, string> = {
	unconfigured: "",
	degraded: "Metrics collection degraded",
	stalled: "Metrics collection stalled",
	waiting: "Waiting for first metrics",
	healthy: "Metrics",
}
