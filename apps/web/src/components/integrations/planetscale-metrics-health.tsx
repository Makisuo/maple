import { useState } from "react"

import { cn } from "@maple/ui/utils"

import type { PlanetScaleScrapeTargetSummary } from "@maple/domain/http"
import { formatRelativeTime } from "@/lib/format"

type HealthState = "degraded" | "waiting" | "stalled" | "healthy"

/**
 * Outcome-level health for the managed branch-metrics collection. Collection
 * itself is fully automatic (Maple provisions and runs it), so the card shows a
 * single status row instead of the underlying machinery: one dot, one label,
 * and — only when degraded — the raw error behind a disclosure.
 */
export function PlanetScaleMetricsHealth({
	target,
	metricsAuth,
}: {
	target: PlanetScaleScrapeTargetSummary
	metricsAuth: "oauth" | "service_token" | "missing"
}) {
	const [detailsOpen, setDetailsOpen] = useState(false)

	// The token-setup step owns the missing-auth state — don't show two messages.
	if (metricsAuth === "missing") return null

	const state: HealthState =
		target.lastScrapeError !== null
			? "degraded"
			: target.lastScrapeAt === null
				? "waiting"
				: Date.now() - target.lastScrapeAt > 3 * target.scrapeIntervalSeconds * 1000
					? "stalled"
					: "healthy"

	const updatedAgo =
		target.lastScrapeAt !== null
			? formatRelativeTime(new Date(target.lastScrapeAt).toISOString())
			: null

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
				<span className="font-medium text-foreground">
					{state === "degraded"
						? "Metrics collection degraded"
						: state === "stalled"
							? "Metrics collection stalled"
							: state === "waiting"
								? "Waiting for first metrics"
								: "Metrics"}
				</span>
				<span className="text-muted-foreground">
					{state === "waiting"
						? "Branch metrics usually appear within a minute of connecting."
						: state === "healthy"
							? `Updated ${updatedAgo}`
							: updatedAgo !== null
								? `Last data ${updatedAgo}`
								: null}
					{state === "healthy" && target.excludeBranches.length > 0 ? (
						<> · excluding {target.excludeBranches.join(", ")}</>
					) : null}
				</span>
				{state === "degraded" ? (
					<button
						type="button"
						onClick={() => setDetailsOpen((open) => !open)}
						className="ml-auto text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
					>
						{detailsOpen ? "Hide details" : "Show details"}
					</button>
				) : null}
			</div>
			{state === "degraded" && detailsOpen ? (
				<p className="mt-2 break-all rounded-md bg-muted/40 p-2 font-mono text-xs text-muted-foreground">
					{target.lastScrapeError}
				</p>
			) : null}
		</div>
	)
}
