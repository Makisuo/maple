import { useEffect } from "react"
import { useNavigate, createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { toast } from "sonner"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import {
	CloudflareAccountCard,
	CloudflareHeaderActions,
} from "@/components/integrations/cloudflare-account-card"
import { GithubIntegrationCard } from "@/components/integrations/github-integration-card"
import { HazelIntegrationCard } from "@/components/integrations/hazel-integration-card"
import { PlanetScaleIntegrationCard } from "@/components/integrations/planetscale-integration-card"
import { SlackIntegrationCard } from "@/components/integrations/slack-integration-card"
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
	// Post-OAuth return params set by the Slack install callback redirect. Plain
	// strings for the same reason as `integration` — a truncated, retried, or
	// hand-edited callback URL must degrade to the catalog, not the error boundary.
	slack: Schema.optional(Schema.String),
	slack_message: Schema.optional(Schema.String),
	slack_team: Schema.optional(Schema.String),
})

/**
 * Slack's documented OAuth `error` codes, plus the messages our own callback
 * emits, mapped to curated copy. Everything reaching the toast is an untrusted
 * URL param — rendering a backend/attacker-authored string verbatim inside an
 * authenticated page is a phishing surface — so unknown values fall back to a
 * generic line rather than being echoed.
 */
// A Map, not an object literal: the key is attacker-controlled, and a plain
// object would happily resolve `toString` / `constructor` off the prototype.
const SLACK_ERROR_COPY = new Map<string, string>([
	["access_denied", "Slack install cancelled — the app wasn't authorized."],
	["invalid_scope", "Slack rejected the requested permissions. Try installing again."],
	[
		"invalid_team_for_non_distributed_app",
		"That Slack workspace can't install this app. Ask a workspace admin for access.",
	],
	["invalid_browser", "Slack couldn't complete the install in this browser. Try again from Slack."],
	["invalid_client_id", "Slack rejected Maple's app credentials. Contact support."],
	["bad_client_secret", "Slack rejected Maple's app credentials. Contact support."],
	["oauth_authorization_url_mismatch", "The Slack install link expired. Start the install again."],
	// Messages our own callback emits (exact literals from
	// `apps/api/src/routes/slack-integration.http.ts` + SlackIntegrationService).
	[
		"This Slack workspace is already connected to a different Maple organization. Uninstall it there first.",
		"That Slack workspace is already connected to a different Maple organization. Uninstall it there first.",
	],
	[
		"Slack state expired — restart the install flow",
		"The Slack install link expired. Start the install again.",
	],
	[
		"Slack state not recognized — restart the install flow",
		"The Slack install link is no longer valid. Start the install again.",
	],
	["Missing code or state in callback", "Slack's callback was incomplete. Start the install again."],
	["Malformed callback URL", "Slack's callback was incomplete. Start the install again."],
])

const GENERIC_SLACK_ERROR = "Slack connection failed. Try installing again."

/** Longest attacker-controlled string we'll surface (workspace names in a toast). */
const MAX_UNTRUSTED_LABEL = 64

const clampLabel = (value: string): string =>
	value.length > MAX_UNTRUSTED_LABEL ? `${value.slice(0, MAX_UNTRUSTED_LABEL - 1)}…` : value

const slackErrorMessage = (raw: string | undefined): string =>
	(raw ? SLACK_ERROR_COPY.get(raw.trim()) : undefined) ?? GENERIC_SLACK_ERROR

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

	// Surface the Slack OAuth callback result once, then strip the return params
	// from the URL so a refresh doesn't re-toast. Narrowed here rather than in
	// `validateSearch` — an unrecognised value is simply not a callback return.
	const slackReturn = search.slack === "connected" || search.slack === "error" ? search.slack : undefined
	const slackMessage = search.slack_message
	const slackTeam = search.slack_team
	useEffect(() => {
		if (!slackReturn) return
		// Keyed toast: StrictMode double-invokes effects, and the navigate below can
		// re-run the effect before the params are stripped — the id dedupes both.
		if (slackReturn === "connected") {
			toast.success(slackTeam ? `Slack connected to ${clampLabel(slackTeam)}` : "Slack connected", {
				id: "slack-oauth",
			})
		} else {
			toast.error(slackErrorMessage(slackMessage), { id: "slack-oauth" })
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
		<IntegrationConnectProvider integration={integration}>
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
