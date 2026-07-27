import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import {
	CloudflareAccountCard,
	CloudflareHeaderActions,
} from "@/components/integrations/cloudflare-account-card"
import { GithubIntegrationCard } from "@/components/integrations/github-integration-card"
import { HazelIntegrationCard } from "@/components/integrations/hazel-integration-card"
import { PlanetScaleIntegrationCard } from "@/components/integrations/planetscale-integration-card"
import {
	IntegrationCatalog,
	IntegrationIconPlate,
	IntegrationsSummary,
	catalogEntry,
	isIntegrationId,
	useIntegrationOverviews,
	useIntegrationStatuses,
	type IntegrationId,
} from "@/components/integrations/integration-catalog"
import {
	IntegrationConnectProvider,
	useIntegrationConnect,
} from "@/components/integrations/integration-connect"
import { ScrapeTargetsSection } from "@/components/settings/scrape-targets-section"
import { SettingsNav, useVisibleSettingsSections } from "@/components/settings/settings-nav"
import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import { ArrowLeftIcon, CircleInfoIcon, ExternalLinkIcon, LoaderIcon } from "@/components/icons"

// Deliberately a plain string rather than a literal union: this page is the
// return target for external OAuth callbacks, which append their own
// `?integration=<id>`. A value we don't recognise must fall back to the catalog,
// never fail `validateSearch` and blank the page.
const IntegrationsSearch = Schema.Struct({
	integration: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/integrations")({
	component: IntegrationsPage,
	validateSearch: Schema.toStandardSchemaV1(IntegrationsSearch),
})

function IntegrationsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { visibleSections } = useVisibleSettingsSections()
	const integration =
		search.integration && isIntegrationId(search.integration) ? search.integration : undefined

	// The hub shares the settings shell: same sidebar, "Integrations" highlighted.
	const settingsSidebar = (
		<SettingsNav
			sections={visibleSections}
			active="integrations"
			onSelectTab={(tab) => navigate({ to: "/settings", search: { tab } })}
		/>
	)

	if (!integration) {
		return (
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[{ label: "Settings", href: "/settings" }, { label: "Integrations" }]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Filters>{settingsSidebar}</DashboardLayout.Filters>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								title="Integrations"
								description="Connect external data sources and services to Maple."
							>
								<IntegrationsSummary />
							</DashboardLayout.Header>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<IntegrationCatalog
								onSelect={(id) => navigate({ search: { integration: id } })}
							/>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		)
	}

	const entry = catalogEntry(integration)

	return (
		<IntegrationConnectProvider integration={integration}>
			<DashboardLayout.Root>
				<DashboardLayout.Breadcrumbs
					items={[
						{ label: "Settings", href: "/settings" },
						{ label: "Integrations", href: "/integrations" },
						{ label: entry.name },
					]}
				/>
				<DashboardLayout.Body>
					<DashboardLayout.Filters>{settingsSidebar}</DashboardLayout.Filters>
					<DashboardLayout.Content>
						<DashboardLayout.Sticky>
							<DashboardLayout.Header
								titleContent={<IntegrationHeader integration={integration} />}
							/>
						</DashboardLayout.Sticky>
						<DashboardLayout.Scroll>
							<div className="space-y-4">
								{integration === "warpstream" && (
									<Alert variant="info">
										<CircleInfoIcon />
										<AlertDescription>
											WarpStream clusters are scraped as Prometheus targets — point a
											target at an agent&apos;s{" "}
											<code className="font-mono text-xs">:8080/metrics</code> endpoint
											or the hosted Prometheus endpoint with Basic auth.{" "}
											<a
												href="https://maple.dev/docs/integrations/warpstream"
												target="_blank"
												rel="noreferrer"
												className="text-foreground underline underline-offset-2 hover:no-underline"
											>
												Setup guide
											</a>
										</AlertDescription>
									</Alert>
								)}
								{integration === "cloudflare" ? (
									<CloudflareAccountCard />
								) : integration === "hazel" ? (
									<HazelIntegrationCard />
								) : integration === "github" ? (
									<GithubIntegrationCard />
								) : integration === "planetscale" ? (
									<PlanetScaleIntegrationCard />
								) : (
									// prometheus + warpstream share the generic scrape-target flow
									<ScrapeTargetsSection sourceFilter="prometheus" />
								)}
							</div>
						</DashboardLayout.Scroll>
					</DashboardLayout.Content>
				</DashboardLayout.Body>
			</DashboardLayout.Root>
		</IntegrationConnectProvider>
	)
}

function IntegrationHeader({ integration }: { integration: IntegrationId }) {
	const navigate = useNavigate({ from: Route.fullPath })
	const entry = catalogEntry(integration)
	const status = useIntegrationStatuses()[integration]
	// Provided by IntegrationConnectProvider for OAuth integrations; null for scrape-based
	// ones — which is also the "no header Connect button" signal. Only shown while the
	// integration is genuinely available (not connected, not errored, not still loading).
	const connectFlow = useIntegrationConnect()
	const overview = useIntegrationOverviews()[integration]
	const showConnect = connectFlow !== null && overview?.kind === "available"
	const connected = overview?.kind === "connected" ? overview : null
	const EntryIcon = entry.icon

	// "Healthy · Acme Corp · synced 2m ago" — the connected identity line under the title.
	const statusLine = connected
		? [connected.stateLabel, connected.context, connected.lastSyncLabel]
				.filter((part): part is string => part != null && part !== "")
				.join(" · ")
		: null

	return (
		<div className="flex items-center gap-3">
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Back to integrations"
				onClick={() => navigate({ search: {} })}
			>
				<ArrowLeftIcon size={16} />
			</Button>
			<IntegrationIconPlate
				icon={entry.icon}
				accent={entry.accent}
				iconClassName={entry.iconClassName}
				size={18}
				plateClassName="size-9 rounded-lg"
			/>
			<div className="flex min-w-0 flex-col gap-0.5">
				<div className="flex items-center gap-2">
					<h1 className="text-lg/6 font-semibold">{entry.name}</h1>
					{/* The badge covers the non-connected states; connected reads as the status line. */}
					{!connected && status ? <Badge variant={status.variant}>{status.label}</Badge> : null}
				</div>
				{connected && statusLine ? (
					<div className="flex items-center gap-1.5">
						<span
							aria-hidden
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								connected.health === "healthy" ? "bg-success" : "bg-warning",
							)}
						/>
						<span className="truncate text-xs text-muted-foreground">{statusLine}</span>
					</div>
				) : null}
			</div>
			<div className="ml-auto flex shrink-0 items-center gap-3">
				{entry.docsUrl ? (
					<a
						href={entry.docsUrl}
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
					>
						Docs
						<ExternalLinkIcon size={12} />
					</a>
				) : null}
				{integration === "cloudflare" && connected ? <CloudflareHeaderActions /> : null}
				{showConnect ? (
					<Button size="sm" onClick={connectFlow.connect} disabled={connectFlow.busy}>
						{connectFlow.busy ? (
							<LoaderIcon size={14} className="animate-spin" />
						) : (
							// No iconClassName here — the glyph inherits the button's text color,
							// same as the in-card Connect buttons.
							<EntryIcon size={14} />
						)}
						Connect {entry.name}
					</Button>
				) : null}
			</div>
		</div>
	)
}
