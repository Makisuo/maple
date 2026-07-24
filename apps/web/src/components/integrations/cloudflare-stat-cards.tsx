import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import type { CloudflareServiceUsage, CloudflareUsageResponse } from "@maple/domain/http"
import { StatSparkline } from "@maple/ui/components/charts/sparkline/stat-sparkline"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { formatNumber } from "@/lib/format"
import { CLOUDFLARE_ACCENT } from "./integration-catalog"
import { toRowUsage } from "./cloudflare-zone-board"

function StatCard({
	eyebrow,
	value,
	sparkline,
	caption,
	href,
}: {
	eyebrow: string
	value: ReactNode
	sparkline?: ReactNode
	caption: ReactNode
	/** Makes the whole card navigate (e.g. the firewall card → the infra dashboard). */
	href?: "/infra/cloudflare"
}) {
	const body = (
		<>
			<span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
				{eyebrow}
			</span>
			<span className="flex items-end justify-between gap-3">
				<span className="text-[22px]/7 font-semibold tracking-tight text-foreground">{value}</span>
				{sparkline}
			</span>
			<span className="text-xs text-muted-foreground">{caption}</span>
		</>
	)
	const frame = "flex min-w-0 flex-1 flex-col gap-2.5 rounded-lg border border-border/60 bg-card px-4 py-3.5"
	if (href) {
		return (
			<Link
				to={href}
				className={cn(
					frame,
					"transition-colors hover:border-border hover:bg-muted/40 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
				)}
			>
				{body}
			</Link>
		)
	}
	return <div className={frame}>{body}</div>
}

/** The "+12% vs previous 24h" caption — quiet unless traffic actually moved up. */
function TrafficDelta({ usage }: { usage: CloudflareUsageResponse }) {
	const previous = usage.previousTotalRequests
	// Old API during the deploy window — no comparison to show.
	if (previous == null) return <>Requests · last 24h</>
	if (previous === 0) {
		return usage.totalRequests > 0 ? <>First 24h of traffic</> : <>Requests · last 24h</>
	}
	const pct = Math.round(((usage.totalRequests - previous) / previous) * 100)
	if (pct === 0) return <>Flat vs previous 24h</>
	return (
		<span className={cn(pct > 0 && "text-success-foreground")}>
			{pct > 0 ? "+" : ""}
			{pct}% vs previous 24h
		</span>
	)
}

/**
 * The drill-in's 24h readout band: traffic (with previous-window delta), active
 * Workers, and org-wide mitigated firewall events. Renders skeletons until the
 * warehouse usage settles; a failed usage fetch keeps the band hidden entirely
 * (callers pass `usage: null`).
 */
export function CloudflareStatCards({
	usage,
	workerServices,
}: {
	usage: CloudflareUsageResponse | null
	/** Pre-filtered `kind === "worker"` services from the same usage response. */
	workerServices: ReadonlyArray<CloudflareServiceUsage>
}) {
	if (usage === null) {
		return (
			<div className="flex flex-col gap-3 sm:flex-row">
				<Skeleton className="h-[104px] flex-1 rounded-lg" />
				<Skeleton className="h-[104px] flex-1 rounded-lg" />
				<Skeleton className="h-[104px] flex-1 rounded-lg" />
			</div>
		)
	}

	const totalPoints = usage.totalRequests > 0 ? toRowUsage(usage, usage.services).points : null
	const activeWorkers = workerServices.filter((service) => service.totalRequests > 0)
	const workerInvocations = workerServices.reduce((sum, service) => sum + service.totalRequests, 0)
	const workerPoints = workerInvocations > 0 ? toRowUsage(usage, workerServices).points : null

	return (
		<div className="flex flex-col gap-3 sm:flex-row">
			<StatCard
				eyebrow="Traffic · 24h"
				value={formatNumber(usage.totalRequests)}
				sparkline={
					totalPoints ? (
						<StatSparkline
							data={totalPoints}
							color={CLOUDFLARE_ACCENT}
							className="h-9 w-28 shrink-0 xl:w-35"
						/>
					) : null
				}
				caption={<TrafficDelta usage={usage} />}
			/>
			<StatCard
				eyebrow="Workers"
				value={`${activeWorkers.length} active`}
				sparkline={
					workerPoints ? (
						<StatSparkline
							data={workerPoints}
							color={CLOUDFLARE_ACCENT}
							className="h-9 w-28 shrink-0 xl:w-35"
						/>
					) : null
				}
				caption={
					workerInvocations > 0
						? `${formatNumber(workerInvocations)} invocations · on service map`
						: "Scripts appear once they serve traffic"
				}
			/>
			<StatCard
				eyebrow="Firewall · 24h"
				value={`${formatNumber(usage.firewallBlockedEvents ?? 0)} blocked`}
				caption="DNS analytics alongside traces"
				href="/infra/cloudflare"
			/>
		</div>
	)
}
