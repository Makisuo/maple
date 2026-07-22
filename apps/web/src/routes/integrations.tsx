import { useEffect } from "react"
import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { toast } from "sonner"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { CloudflareAccountCard } from "@/components/integrations/cloudflare-account-card"
import { GithubIntegrationCard } from "@/components/integrations/github-integration-card"
import { HazelIntegrationCard } from "@/components/integrations/hazel-integration-card"
import { PlanetScaleIntegrationCard } from "@/components/integrations/planetscale-integration-card"
import { SlackIntegrationCard } from "@/components/integrations/slack-integration-card"
import {
	IntegrationCatalog,
	IntegrationIconPlate,
	IntegrationsSummary,
	catalogEntry,
	useIntegrationStatuses,
	type IntegrationId,
} from "@/components/integrations/integration-catalog"
import { ScrapeTargetsSection } from "@/components/settings/scrape-targets-section"
import { SettingsNav, useVisibleSettingsSections } from "@/components/settings/settings-nav"
import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ArrowLeftIcon, CircleInfoIcon, ExternalLinkIcon } from "@/components/icons"

const IntegrationsSearch = Schema.Struct({
	integration: Schema.optional(
		Schema.Literals([
			"cloudflare",
			"prometheus",
			"planetscale",
			"warpstream",
			"hazel",
			"github",
			"slack",
		]),
	),
	// Post-OAuth return params set by the Slack install callback redirect.
	slack: Schema.optional(Schema.Literals(["connected", "error"])),
	slack_message: Schema.optional(Schema.String),
	slack_team: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/integrations")({
	component: IntegrationsPage,
	validateSearch: Schema.toStandardSchemaV1(IntegrationsSearch),
})

function IntegrationsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const { visibleSections } = useVisibleSettingsSections()
	const integration = search.integration

	// Surface the Slack OAuth callback result once, then strip the return params
	// from the URL so a refresh doesn't re-toast.
	const slackReturn = search.slack
	const slackMessage = search.slack_message
	const slackTeam = search.slack_team
	useEffect(() => {
		if (!slackReturn) return
		// Keyed toast: StrictMode double-invokes effects, and the navigate below can
		// re-run the effect before the params are stripped — the id dedupes both.
		if (slackReturn === "connected") {
			toast.success(slackTeam ? `Slack connected to ${slackTeam}` : "Slack connected", {
				id: "slack-oauth",
			})
		} else {
			toast.error(slackMessage ?? "Slack connection failed", { id: "slack-oauth" })
		}
		navigate({ search: { integration: "slack" }, replace: true })
	}, [slackReturn, slackMessage, slackTeam, navigate])

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
			<DashboardLayout
				breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Integrations" }]}
				title="Integrations"
				description="Connect external data sources and services to Maple."
				headerActions={<IntegrationsSummary />}
				filterSidebar={settingsSidebar}
			>
				<IntegrationCatalog onSelect={(id) => navigate({ search: { integration: id } })} />
			</DashboardLayout>
		)
	}

	const entry = catalogEntry(integration)

	return (
		<DashboardLayout
			breadcrumbs={[
				{ label: "Settings", href: "/settings" },
				{ label: "Integrations", href: "/integrations" },
				{ label: entry.name },
			]}
			titleContent={<IntegrationHeader integration={integration} />}
			filterSidebar={settingsSidebar}
		>
			<div className="space-y-4">
				{integration === "warpstream" && (
					<Alert variant="info">
						<CircleInfoIcon />
						<AlertDescription>
							WarpStream clusters are scraped as Prometheus targets — point a target at an
							agent&apos;s <code className="font-mono text-xs">:8080/metrics</code> endpoint
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
				) : integration === "slack" ? (
					<SlackIntegrationCard />
				) : (
					// prometheus + warpstream share the generic scrape-target flow
					<ScrapeTargetsSection sourceFilter="prometheus" />
				)}
			</div>
		</DashboardLayout>
	)
}

function IntegrationHeader({ integration }: { integration: IntegrationId }) {
	const navigate = useNavigate({ from: Route.fullPath })
	const entry = catalogEntry(integration)
	const status = useIntegrationStatuses()[integration]

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
			<div className="flex items-center gap-2">
				<h1 className="text-lg font-semibold">{entry.name}</h1>
				{status ? <Badge variant={status.variant}>{status.label}</Badge> : null}
			</div>
			{entry.docsUrl ? (
				<a
					href={entry.docsUrl}
					target="_blank"
					rel="noreferrer"
					className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
				>
					Docs
					<ExternalLinkIcon size={12} />
				</a>
			) : null}
		</div>
	)
}
