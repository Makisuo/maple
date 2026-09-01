// The bridge from the fleet page to /integrations.
//
// Hosts and containers arrive through the agent, but Cloudflare, PlanetScale and
// Prometheus infrastructure only shows up once the matching integration is
// connected — and until now nothing on /infra said so. Someone whose whole estate
// is behind Cloudflare landed on an empty host list with no hint that the data
// lives one connection away. This strip states each source's status and routes
// you to the drill-in when it's live, to the integration when it isn't.

import { Link } from "@tanstack/react-router"

import { Badge } from "@maple/ui/components/ui/badge"
import { cn } from "@maple/ui/lib/utils"

import { ChevronRightIcon } from "@/components/icons"
import {
	IntegrationIconPlate,
	catalogEntry,
	useIntegrationOverviews,
	type IntegrationId,
	type IntegrationOverview,
} from "@/components/integrations/integration-catalog"

interface InfraSource {
	readonly id: IntegrationId
	/**
	 * Where a *connected* source drills in. Absent for Prometheus — its targets
	 * feed metrics rather than an infra page, so it stays on the integration.
	 */
	readonly to?: "/infra/cloudflare" | "/infra/planetscale"
	/** One line of what the source contributes, shown before it is connected. */
	readonly blurb: string
}

// Infra-producing catalog entries only. Slack/GitHub/Hazel are real integrations
// but nothing they sync appears on this page, so they'd be noise here.
const INFRA_SOURCES: ReadonlyArray<InfraSource> = [
	{ id: "cloudflare", to: "/infra/cloudflare", blurb: "Zone traffic and Workers" },
	{ id: "planetscale", to: "/infra/planetscale", blurb: "Database branch metrics" },
	{ id: "prometheus", blurb: "Scrape any metrics endpoint" },
]

export function InfraIntegrations() {
	const overviews = useIntegrationOverviews()

	return (
		<section className="space-y-3">
			<div className="flex items-center justify-between gap-3">
				<div className="space-y-0.5">
					<h2 className="text-sm font-semibold">Infrastructure sources</h2>
					<p className="text-xs text-muted-foreground">
						Agentless telemetry from connected providers.
					</p>
				</div>
				<Link
					to="/integrations"
					className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
				>
					All integrations
				</Link>
			</div>
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{INFRA_SOURCES.map((source) => (
					<InfraSourceCard key={source.id} source={source} overview={overviews[source.id]} />
				))}
			</div>
		</section>
	)
}

function InfraSourceCard({ source, overview }: { source: InfraSource; overview: IntegrationOverview }) {
	const entry = catalogEntry(source.id)
	const connected = overview?.kind === "connected" ? overview : null
	// `overview === null` is "still loading" — neither badge branch fires, so the
	// card says nothing rather than claiming the source is disconnected.
	const available = overview?.kind === "available" ? overview : null
	const body = (
		<>
			<IntegrationIconPlate
				icon={entry.icon}
				accent={entry.accent}
				iconClassName={entry.iconClassName}
				plateClassName="size-9 rounded-lg"
				size={20}
			/>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-sm font-semibold">{entry.name}</span>
				<span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
					{connected ? (
						<>
							<span
								aria-hidden
								className={cn(
									"size-1.5 shrink-0 rounded-full",
									connected.health === "healthy" ? "bg-success" : "bg-warning",
								)}
							/>
							<span className="truncate">
								{connected.stat ?? connected.context ?? connected.stateLabel}
							</span>
						</>
					) : (
						<span className="truncate">{source.blurb}</span>
					)}
				</span>
			</span>
			{connected?.issue ? (
				<Badge variant="warning" size="sm">
					{connected.issue}
				</Badge>
			) : available ? (
				<Badge variant="outline" size="sm">
					{available.cta}
				</Badge>
			) : overview?.kind === "unavailable" ? (
				<Badge variant="outline" size="sm">
					Status unavailable
				</Badge>
			) : null}
			<ChevronRightIcon
				size={14}
				className="shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground"
			/>
		</>
	)

	const className =
		"group flex items-center gap-3 rounded-lg border border-border/60 bg-card p-3 text-left outline-none transition-colors hover:border-border hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"

	return connected && source.to ? (
		<Link to={source.to} className={className}>
			{body}
		</Link>
	) : (
		<Link to="/integrations" search={{ integration: entry.id }} className={className}>
			{body}
		</Link>
	)
}
