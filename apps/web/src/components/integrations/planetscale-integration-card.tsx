import { useState } from "react"
import { Cause, Exit } from "effect"
import { PlanetScaleMetricsTokenRequest, PlanetScaleSelectOrganizationRequest } from "@maple/domain/http"
import { Alert, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toast } from "sonner"

import { CheckIcon, CircleWarningIcon, LoaderIcon, PlanetScaleIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { IntegrationIconPlate, catalogEntry } from "./integration-catalog"
import { useIntegrationConnect } from "./integration-connect"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"
import { PlanetScaleMetricsHealth } from "./planetscale-metrics-health"

const PLANETSCALE_ENTRY = catalogEntry("planetscale")

/** Comma/newline separated globs → trimmed list. */
const parsePatternList = (value: string): string[] =>
	value
		.split(/[\n,]/)
		.map((pattern) => pattern.trim())
		.filter((pattern) => pattern.length > 0)

/**
 * First-class PlanetScale connection card: authorize Maple's OAuth application
 * in a popup, pick the PlanetScale organization (auto-bound when the grant
 * reaches exactly one), and Maple collects branch metrics, polls database
 * inventory, and proxies query insights automatically. Collection health shows
 * as a single status row — the machinery stays out of the UI.
 */
export function PlanetScaleIntegrationCard() {
	const statusQuery = MapleApiAtomClient.query("integrations", "planetscaleStatus", {
		reactivityKeys: ["planetscaleIntegrationStatus"],
	})
	const statusResult = useAtomValue(statusQuery)
	const refreshStatus = useAtomRefresh(statusQuery)

	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "planetscaleDisconnect"), {
		mode: "promiseExit",
	})

	// Connect flow (popup, busy, refresh-on-return) lives in IntegrationConnectProvider —
	// shared with the drill-in header's Connect button.
	const connectFlow = useIntegrationConnect()
	if (connectFlow === null) {
		throw new Error("PlanetScaleIntegrationCard must be rendered inside IntegrationConnectProvider")
	}
	const [disconnectBusy, setDisconnectBusy] = useState(false)
	const actionBusy = connectFlow.busy || disconnectBusy
	const [pickerOpen, setPickerOpen] = useState(false)

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() => null)
	const isConnected = status?.connected === true
	const pendingOrgSelection = status?.pendingOrgSelection === true

	async function handleDisconnect() {
		setDisconnectBusy(true)
		const result = await disconnect({
			reactivityKeys: ["planetscaleIntegrationStatus", "scrapeTargets"],
		})
		setDisconnectBusy(false)
		if (Exit.isSuccess(result)) {
			toast.success("PlanetScale organization disconnected")
			refreshStatus()
		} else {
			toast.error("Failed to disconnect PlanetScale organization")
		}
	}

	// Guard the first fetch so a connected org doesn't flash the "Connect" empty state.
	if (Result.isInitial(statusResult)) {
		return <Skeleton className="h-40 w-full rounded-lg" />
	}

	// A failed status fetch is not "not connected" — don't offer the connect CTA
	// over an org that may already be authorized.
	if (Result.isFailure(statusResult)) {
		return (
			<div className="flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4">
				<IntegrationIconPlate icon={PlanetScaleIcon} accent={PLANETSCALE_ENTRY.accent} />
				<div className="flex flex-col gap-1">
					<h3 className="text-sm font-semibold">PlanetScale</h3>
					<p className="text-xs text-muted-foreground">
						Couldn&apos;t load the PlanetScale connection status — refresh the page to try again.
					</p>
				</div>
			</div>
		)
	}

	// Grant stored, organization not chosen yet: the picker is the whole card.
	if (!isConnected && pendingOrgSelection) {
		return (
			<div className="overflow-hidden rounded-lg border border-border/60 bg-card">
				<div className="flex items-start gap-3 p-4">
					<IntegrationIconPlate icon={PlanetScaleIcon} accent={PLANETSCALE_ENTRY.accent} />
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h3 className="text-sm font-semibold">PlanetScale</h3>
							<Badge variant="secondary">Authorized</Badge>
						</div>
						<p className="mt-1 text-xs text-muted-foreground">
							The authorization covers multiple PlanetScale organizations — choose which one to
							connect.
						</p>
					</div>
				</div>
				<div className="border-t border-border/60 p-4">
					<PlanetScaleOrgPicker
						onDone={() => refreshStatus()}
						onCancel={handleDisconnect}
						cancelLabel="Disconnect"
					/>
				</div>
			</div>
		)
	}

	if (!isConnected) {
		return (
			<IntegrationEmpty
				icon={PlanetScaleIcon}
				accent={PLANETSCALE_ENTRY.accent}
				iconClassName={PLANETSCALE_ENTRY.iconClassName}
			>
				<IntegrationEmptyFeatures>
					<IntegrationEmptyFeature
						label="Service map"
						title="Databases join the map"
						description="Linked to the services that query them, with branches tracked automatically."
					/>
					<IntegrationEmptyFeature
						label="Query insights"
						title="Top queries per branch"
						description="Calls, rows read, and time per query — proxied straight from PlanetScale."
					/>
					<IntegrationEmptyFeature
						label="Branch health"
						title="CPU, memory, replication"
						description="Connections and replication lag per branch, scraped on a schedule."
					/>
				</IntegrationEmptyFeatures>
				<IntegrationEmptyCard>
					<IntegrationEmptyMedia />
					<IntegrationEmptyHint>
						Your databases and branches will appear here after connecting.
					</IntegrationEmptyHint>
					<Button onClick={connectFlow.connect} disabled={actionBusy}>
						{connectFlow.busy ? (
							<LoaderIcon size={16} className="animate-spin" />
						) : (
							<PlanetScaleIcon size={16} />
						)}
						Connect PlanetScale
					</Button>
				</IntegrationEmptyCard>
			</IntegrationEmpty>
		)
	}

	const target = status?.scrapeTarget ?? null
	const missingDatabasesPermission = status?.detectedPermissions?.readDatabases === false

	return (
		<div className="flex flex-col gap-4">
			<div className="overflow-hidden rounded-lg border border-border/60 bg-card">
				<div className="flex flex-wrap items-start justify-between gap-3 p-4">
					<div className="flex min-w-0 items-start gap-3">
						<IntegrationIconPlate icon={PlanetScaleIcon} accent={PLANETSCALE_ENTRY.accent} />
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<h3 className="text-sm font-semibold">PlanetScale</h3>
								<Badge variant="success">Connected</Badge>
							</div>
							<p className="mt-1 text-xs text-muted-foreground">
								{status?.metricsAuth === "missing" ? (
									<>
										Connected to{" "}
										<span className="font-medium text-foreground">
											{status?.organization}
										</span>
										{" — inventory, insights, and webhooks are live."}
									</>
								) : (
									<>
										Streaming branch metrics from{" "}
										<span className="font-medium text-foreground">
											{status?.organization}
										</span>
									</>
								)}
							</p>
						</div>
					</div>

					<div className="flex shrink-0 items-center gap-1.5">
						<Button
							size="sm"
							variant="outline"
							onClick={() => setPickerOpen(true)}
							disabled={actionBusy}
						>
							Change organization
						</Button>
						<Button size="sm" variant="outline" onClick={handleDisconnect} disabled={actionBusy}>
							{disconnectBusy ? <LoaderIcon size={14} className="animate-spin" /> : null}
							Disconnect
						</Button>
					</div>
				</div>

				{status ? (
					<PlanetScaleMetricsSetup
						metricsAuth={status.metricsAuth}
						onSaved={() => refreshStatus()}
					/>
				) : null}

				{status && target ? (
					<PlanetScaleMetricsHealth target={target} metricsAuth={status.metricsAuth} />
				) : null}

				{missingDatabasesPermission ? (
					<div className="border-t border-border/60 p-4">
						<Alert variant="warning">
							<CircleWarningIcon />
							<AlertTitle>Database inventory unavailable</AlertTitle>
							<AlertDescription>
								The authorization can read metrics but not databases — grant the OAuth
								application the <code className="font-mono text-xs">read_databases</code>{" "}
								scope so Maple can link databases on the service map, then reconnect.
							</AlertDescription>
						</Alert>
					</div>
				) : null}
			</div>

			<PlanetScaleWebhookSetup />

			{/* Re-binding to another org the grant covers — finalize is an upsert. */}
			<Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Change PlanetScale organization</DialogTitle>
						<DialogDescription>
							Pick another organization the authorization covers. Metrics collection follows
							automatically.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel>
						<PlanetScaleOrgPicker
							initialOrganization={status?.organization ?? null}
							initialExcludeBranches={status?.scrapeTarget?.excludeBranches.join(", ") ?? ""}
							onDone={() => {
								setPickerOpen(false)
								refreshStatus()
							}}
							onCancel={() => setPickerOpen(false)}
							cancelLabel="Cancel"
						/>
					</DialogPanel>
				</DialogContent>
			</Dialog>
		</div>
	)
}

/**
 * The metrics half of the hybrid setup. The OAuth grant covers the management
 * plane (inventory, insights, webhooks), but PlanetScale's metrics endpoints
 * only accept service tokens — so the connected card carries one follow-up
 * step: paste a token created with just the read_metrics_endpoints permission.
 * Once configured it collapses to a quiet confirmation row with a rotate
 * affordance.
 */
function PlanetScaleMetricsSetup({
	metricsAuth,
	onSaved,
}: {
	metricsAuth: "oauth" | "service_token" | "missing"
	onSaved: () => void
}) {
	const setMetricsToken = useAtomSet(
		MapleApiAtomClient.mutation("integrations", "planetscaleSetMetricsToken"),
		{ mode: "promiseExit" },
	)
	const [formOpen, setFormOpen] = useState(false)
	const [tokenId, setTokenId] = useState("")
	const [tokenSecret, setTokenSecret] = useState("")
	const [submitting, setSubmitting] = useState(false)

	// Scraping works through the grant — nothing to set up.
	if (metricsAuth === "oauth") return null

	const showForm = metricsAuth === "missing" || formOpen

	async function handleSubmit() {
		setSubmitting(true)
		const result = await setMetricsToken({
			payload: new PlanetScaleMetricsTokenRequest({ tokenId: tokenId.trim(), tokenSecret }),
			// The managed scrape target row below flips authType/enabled — refresh it too.
			reactivityKeys: ["planetscaleIntegrationStatus", "scrapeTargets"],
		})
		setSubmitting(false)
		if (Exit.isSuccess(result)) {
			toast.success("Branch metrics enabled")
			setTokenId("")
			setTokenSecret("")
			setFormOpen(false)
			onSaved()
		} else {
			// Surface the API's message (token rejected, wrong permission, …) — actionable.
			toast.error(extractErrorMessage(result) ?? "Failed to save the metrics service token")
		}
	}

	return (
		<div className="border-t border-border/60 p-4">
			{metricsAuth === "service_token" ? (
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<CheckIcon size={14} className="shrink-0 text-severity-info" />
						<span>
							Branch metrics authenticated with a service token
							{" — inventory, insights, and webhooks use the OAuth grant."}
						</span>
					</div>
					{!formOpen ? (
						<Button size="sm" variant="outline" onClick={() => setFormOpen(true)}>
							Rotate token
						</Button>
					) : null}
				</div>
			) : (
				<div className="space-y-1">
					<div className="flex items-center gap-2">
						<h4 className="text-sm font-semibold">Enable branch metrics</h4>
						<Badge variant="warning">1 step left</Badge>
					</div>
					<p className="text-xs text-muted-foreground">
						PlanetScale only exposes branch metrics (CPU, connections, replication lag) to service
						tokens. Create one in the organization settings with just the{" "}
						<code className="font-mono">read_metrics_endpoints</code> permission and paste it here
						— everything else already runs on the OAuth authorization.
					</p>
				</div>
			)}

			{showForm ? (
				<div className="mt-3 flex flex-wrap items-end gap-2">
					<div className="flex min-w-40 flex-1 flex-col gap-1.5">
						<Label htmlFor="ps-metrics-token-id">Service token ID</Label>
						<Input
							id="ps-metrics-token-id"
							placeholder="tok_…"
							value={tokenId}
							onChange={(event) => setTokenId(event.target.value)}
							autoComplete="off"
						/>
					</div>
					<div className="flex min-w-40 flex-1 flex-col gap-1.5">
						<Label htmlFor="ps-metrics-token-secret">Service token secret</Label>
						<Input
							id="ps-metrics-token-secret"
							type="password"
							placeholder="pscale_tkn_…"
							value={tokenSecret}
							onChange={(event) => setTokenSecret(event.target.value)}
							autoComplete="off"
						/>
					</div>
					<div className="flex items-center gap-1.5">
						{metricsAuth === "service_token" ? (
							<Button
								variant="outline"
								onClick={() => setFormOpen(false)}
								disabled={submitting}
							>
								Cancel
							</Button>
						) : null}
						<Button
							onClick={handleSubmit}
							disabled={submitting || tokenId.trim().length === 0 || tokenSecret.length === 0}
						>
							{submitting ? <LoaderIcon size={14} className="animate-spin" /> : null}
							{metricsAuth === "service_token" ? "Update token" : "Enable metrics"}
						</Button>
					</div>
				</div>
			) : null}
		</div>
	)
}

/**
 * Organization picker over the stored OAuth grant: lists the orgs the grant can
 * access and finalizes the binding via select-organization. Rendered inline for
 * the pending state and inside a dialog for post-connect re-binding.
 */
function PlanetScaleOrgPicker(props: {
	initialOrganization?: string | null
	initialExcludeBranches?: string
	onDone: () => void
	onCancel: () => void
	cancelLabel: string
}) {
	const organizationsResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "planetscaleOrganizations", {
			reactivityKeys: ["planetscaleIntegrationStatus"],
		}),
	)
	const selectOrganization = useAtomSet(
		MapleApiAtomClient.mutation("integrations", "planetscaleSelectOrganization"),
		{ mode: "promiseExit" },
	)

	const [selected, setSelected] = useState<string | null>(props.initialOrganization ?? null)
	const [excludeBranches, setExcludeBranches] = useState(props.initialExcludeBranches ?? "")
	const [submitting, setSubmitting] = useState(false)

	async function handleSubmit() {
		if (selected === null) return
		setSubmitting(true)
		const patterns = parsePatternList(excludeBranches)
		const result = await selectOrganization({
			payload: new PlanetScaleSelectOrganizationRequest({
				organization: selected,
				...(patterns.length > 0 ? { excludeBranches: patterns } : {}),
			}),
			// finalizeOrgSelection re-parents the managed scrape target — refresh the list below.
			reactivityKeys: ["planetscaleIntegrationStatus", "scrapeTargets"],
		})
		setSubmitting(false)
		if (Exit.isSuccess(result)) {
			toast.success(`PlanetScale organization ${selected} connected`)
			props.onDone()
		} else {
			// Surface the API's message (missing scope, org outside the grant, …) — actionable.
			toast.error(extractErrorMessage(result) ?? "Failed to connect PlanetScale organization")
		}
	}

	if (Result.isInitial(organizationsResult)) {
		return <Skeleton className="h-24 w-full" />
	}
	if (Result.isFailure(organizationsResult)) {
		return (
			<p className="text-xs text-muted-foreground">
				Couldn&apos;t list the authorized PlanetScale organizations — the authorization may have been
				revoked. Disconnect and connect again.
			</p>
		)
	}
	const organizations = organizationsResult.value.organizations

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5" role="radiogroup" aria-label="PlanetScale organization">
				{organizations.map((org) => (
					<button
						key={org.id}
						type="button"
						role="radio"
						aria-checked={selected === org.name}
						onClick={() => setSelected(org.name)}
						className={cn(
							"flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors",
							selected === org.name
								? "border-primary bg-primary/5 font-medium"
								: "border-border/60 hover:bg-muted/50",
						)}
					>
						<span className="truncate">{org.name}</span>
						{selected === org.name ? (
							<span className="text-xs text-primary">Selected</span>
						) : null}
					</button>
				))}
			</div>
			<div className="flex flex-col gap-2">
				<Label htmlFor="ps-exclude-branches">Exclude branches (optional)</Label>
				<Input
					id="ps-exclude-branches"
					placeholder="pr-*, preview-*"
					value={excludeBranches}
					onChange={(event) => setExcludeBranches(event.target.value)}
					autoComplete="off"
				/>
				<p className="text-xs text-muted-foreground">
					Glob patterns for branches to skip — keeps preview branches out of your metrics.
				</p>
			</div>
			<DialogFooter>
				<Button variant="outline" onClick={props.onCancel} disabled={submitting}>
					{props.cancelLabel}
				</Button>
				<Button onClick={handleSubmit} disabled={submitting || selected === null}>
					{submitting ? <LoaderIcon size={14} className="animate-spin" /> : null}
					Connect organization
				</Button>
			</DialogFooter>
		</div>
	)
}

/**
 * Manual webhook setup: PlanetScale webhooks are configured per database in
 * the PlanetScale dashboard, so Maple shows the endpoint URL + HMAC secret to
 * paste there. The secret is fetched (admin-only) only after the reveal click.
 */
function PlanetScaleWebhookSetup() {
	const [revealed, setRevealed] = useState(false)
	return (
		<div className="overflow-hidden rounded-lg border border-border/60 bg-card">
			<div className="flex flex-wrap items-start justify-between gap-3 p-4">
				<div className="min-w-0">
					<h3 className="text-sm font-semibold">Webhooks</h3>
					<p className="mt-1 text-xs text-muted-foreground">
						Register this endpoint in each database&apos;s webhook settings on PlanetScale — OOM
						restarts, storage thresholds, and anomalies then open triage issues in Maple.
					</p>
				</div>
				{!revealed ? (
					<Button size="sm" variant="outline" onClick={() => setRevealed(true)}>
						Show setup
					</Button>
				) : null}
			</div>
			{revealed ? <PlanetScaleWebhookConfig /> : null}
		</div>
	)
}

function PlanetScaleWebhookConfig() {
	const configResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "planetscaleWebhookConfig", {
			reactivityKeys: ["planetscaleIntegrationStatus"],
		}),
	)
	if (Result.isInitial(configResult)) {
		return <Skeleton className="mx-4 mb-4 h-16" />
	}
	if (Result.isFailure(configResult)) {
		return (
			<p className="px-4 pb-4 text-xs text-muted-foreground">
				Couldn&apos;t load the webhook configuration — only org admins can view it.
			</p>
		)
	}
	const config = configResult.value
	if (!config.configured || !config.url || !config.secret) {
		return (
			<p className="px-4 pb-4 text-xs text-muted-foreground">
				No webhook secret on this connection yet — reconnect to mint one.
			</p>
		)
	}
	return (
		<div className="space-y-3 border-t border-border/60 p-4">
			<div className="space-y-1">
				<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					Webhook URL
				</span>
				<p className="break-all font-mono text-xs text-foreground">{config.url}</p>
			</div>
			<div className="space-y-1">
				<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					Secret
				</span>
				<p className="break-all font-mono text-xs text-foreground">{config.secret}</p>
			</div>
			<p className="text-[11px] text-muted-foreground">
				PlanetScale signs each delivery with this secret (
				<code className="font-mono">X-PlanetScale-Signature</code>); Maple rejects anything that
				doesn&apos;t verify.
			</p>
		</div>
	)
}

/** Best-effort human message from a failed mutation Exit (tagged API errors carry one). */
function extractErrorMessage(result: Exit.Exit<unknown, unknown>): string | null {
	if (Exit.isSuccess(result)) return null
	const first = Cause.prettyErrors(result.cause)[0]
	if (first?.message) return first.message
	return null
}
