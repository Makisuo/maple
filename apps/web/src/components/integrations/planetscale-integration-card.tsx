import { useState } from "react"
import { Cause, Exit } from "effect"
import { PlanetScaleConnectRequest } from "@maple/domain/http"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { toast } from "sonner"

import { CircleWarningIcon, LoaderIcon, PlanetScaleIcon } from "@/components/icons"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { formatRelativeTime } from "@/lib/format"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { ScrapeTargetsSection } from "@/components/settings/scrape-targets-section"
import { IntegrationIconPlate, catalogEntry } from "./integration-catalog"
import { IntegrationEmptyState } from "./integration-empty-state"

const PLANETSCALE_ENTRY = catalogEntry("planetscale")

/** Comma/newline separated globs → trimmed list. */
const parsePatternList = (value: string): string[] =>
	value
		.split(/[\n,]/)
		.map((pattern) => pattern.trim())
		.filter((pattern) => pattern.length > 0)

/**
 * First-class PlanetScale connection card: paste a service token once and Maple
 * validates it, provisions the managed branch-metrics scrape target, and (in
 * later phases) polls database inventory + query insights. The managed scrape
 * target's per-branch health renders below via the shared scrape-target list.
 */
export function PlanetScaleIntegrationCard() {
	const statusQuery = MapleApiAtomClient.query("integrations", "planetscaleStatus", {
		reactivityKeys: ["planetscaleIntegrationStatus"],
	})
	const statusResult = useAtomValue(statusQuery)
	const refreshStatus = useAtomRefresh(statusQuery)

	const connect = useAtomSet(MapleApiAtomClient.mutation("integrations", "planetscaleConnect"), {
		mode: "promiseExit",
	})
	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "planetscaleDisconnect"), {
		mode: "promiseExit",
	})

	const [dialogOpen, setDialogOpen] = useState(false)
	const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null)
	const [formOrganization, setFormOrganization] = useState("")
	const [formTokenId, setFormTokenId] = useState("")
	const [formTokenSecret, setFormTokenSecret] = useState("")
	const [formExcludeBranches, setFormExcludeBranches] = useState("")

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() => null)
	const isConnected = status?.connected === true

	function openConnectDialog() {
		setFormOrganization(status?.organization ?? "")
		setFormTokenId("")
		setFormTokenSecret("")
		setFormExcludeBranches(status?.scrapeTarget?.excludeBranches.join(", ") ?? "")
		setDialogOpen(true)
	}

	async function handleConnect() {
		setBusy("connect")
		const excludeBranches = parsePatternList(formExcludeBranches)
		const result = await connect({
			payload: new PlanetScaleConnectRequest({
				organization: formOrganization.trim(),
				tokenId: formTokenId.trim(),
				tokenSecret: formTokenSecret,
				...(excludeBranches.length > 0 ? { excludeBranches } : {}),
			}),
			reactivityKeys: ["planetscaleIntegrationStatus"],
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			toast.success("PlanetScale organization connected")
			setDialogOpen(false)
			refreshStatus()
		} else {
			// Surface the API's message (token rejected, unknown org, …) — it's actionable.
			toast.error(extractErrorMessage(result) ?? "Failed to connect PlanetScale organization")
		}
	}

	async function handleDisconnect() {
		setBusy("disconnect")
		const result = await disconnect({
			reactivityKeys: ["planetscaleIntegrationStatus"],
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			toast.success("PlanetScale organization disconnected")
			refreshStatus()
		} else {
			toast.error("Failed to disconnect PlanetScale organization")
		}
	}

	const connectDialog = (
		<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						{isConnected ? "Update PlanetScale connection" : "Connect PlanetScale"}
					</DialogTitle>
					<DialogDescription>
						Create a service token in the PlanetScale organization settings with the{" "}
						<code className="font-mono text-xs">read_metrics_endpoints</code> and{" "}
						<code className="font-mono text-xs">read_databases</code> permissions.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="flex flex-col gap-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="ps-organization">Organization</Label>
						<Input
							id="ps-organization"
							placeholder="my-org"
							value={formOrganization}
							onChange={(event) => setFormOrganization(event.target.value)}
							autoComplete="off"
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="ps-token-id">Service token ID</Label>
						<Input
							id="ps-token-id"
							placeholder="tok_…"
							value={formTokenId}
							onChange={(event) => setFormTokenId(event.target.value)}
							autoComplete="off"
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="ps-token-secret">Service token secret</Label>
						<Input
							id="ps-token-secret"
							type="password"
							placeholder="pscale_tkn_…"
							value={formTokenSecret}
							onChange={(event) => setFormTokenSecret(event.target.value)}
							autoComplete="off"
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="ps-exclude-branches">Exclude branches (optional)</Label>
						<Input
							id="ps-exclude-branches"
							placeholder="pr-*, preview-*"
							value={formExcludeBranches}
							onChange={(event) => setFormExcludeBranches(event.target.value)}
							autoComplete="off"
						/>
						<p className="text-xs text-muted-foreground">
							Glob patterns for branches to skip — keeps preview branches from being scraped.
						</p>
					</div>
				</DialogPanel>
				<DialogFooter>
					<Button variant="outline" onClick={() => setDialogOpen(false)} disabled={busy !== null}>
						Cancel
					</Button>
					<Button
						onClick={handleConnect}
						disabled={
							busy !== null ||
							formOrganization.trim().length === 0 ||
							formTokenId.trim().length === 0 ||
							formTokenSecret.length === 0
						}
					>
						{busy === "connect" ? <LoaderIcon size={14} className="animate-spin" /> : null}
						{isConnected ? "Update connection" : "Connect"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)

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
						Couldn't load the PlanetScale connection status — refresh the page to try again.
					</p>
				</div>
			</div>
		)
	}

	if (!isConnected) {
		return (
			<>
				<IntegrationEmptyState
					icon={PlanetScaleIcon}
					accent={PLANETSCALE_ENTRY.accent}
					title="Connect your PlanetScale organization"
					description="Paste a service token once — Maple discovers every database branch and streams CPU, connections, replication lag, and query metrics into your dashboards."
					features={[
						"Branch metrics scraped automatically, no agent required",
						"Databases appear on the service map with live health",
						"Branch filters keep preview branches out",
					]}
					footer="The token needs the read_metrics_endpoints organization permission."
				>
					<Button onClick={openConnectDialog}>
						<PlanetScaleIcon size={16} />
						Connect PlanetScale
					</Button>
				</IntegrationEmptyState>
				{connectDialog}
			</>
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
								Streaming branch metrics from{" "}
								<span className="font-medium text-foreground">{status?.organization}</span>
								{status?.tokenId ? (
									<Tooltip>
										<TooltipTrigger
											render={<span />}
											className="ml-1 cursor-help font-mono text-[11px] text-muted-foreground"
										>
											· {status.tokenId.slice(0, 12)}…
										</TooltipTrigger>
										<TooltipContent className="font-mono text-xs">
											Service token {status.tokenId}
										</TooltipContent>
									</Tooltip>
								) : null}
							</p>
							{target ? (
								<p className="mt-1 text-xs text-muted-foreground">
									{target.lastScrapeAt ? (
										<>
											Last scrape{" "}
											{formatRelativeTime(new Date(target.lastScrapeAt).toISOString())} ·
											every {target.scrapeIntervalSeconds}s
										</>
									) : (
										"First scrape starts within a minute."
									)}
									{target.excludeBranches.length > 0 ? (
										<> · excluding {target.excludeBranches.join(", ")}</>
									) : null}
								</p>
							) : null}
						</div>
					</div>

					<div className="flex shrink-0 items-center gap-1.5">
						<Button size="sm" variant="outline" onClick={openConnectDialog} disabled={busy !== null}>
							Update connection
						</Button>
						<Button size="sm" variant="outline" onClick={handleDisconnect} disabled={busy !== null}>
							{busy === "disconnect" ? <LoaderIcon size={14} className="animate-spin" /> : null}
							Disconnect
						</Button>
					</div>
				</div>

				{missingDatabasesPermission ? (
					<div className="border-t border-border/60 p-4">
						<Alert variant="warning">
							<CircleWarningIcon />
							<AlertTitle>Database inventory unavailable</AlertTitle>
							<AlertDescription>
								The service token can read metrics but not databases — grant it the{" "}
								<code className="font-mono text-xs">read_databases</code> permission so Maple
								can link databases on the service map, then update the connection.
							</AlertDescription>
						</Alert>
					</div>
				) : null}

				{target?.lastScrapeError ? (
					<div className="border-t border-border/60 p-4">
						<Alert variant="warning">
							<CircleWarningIcon />
							<AlertTitle>Metrics collection degraded</AlertTitle>
							<AlertDescription className="font-mono text-xs">
								{target.lastScrapeError}
							</AlertDescription>
						</Alert>
					</div>
				) : null}
			</div>

			<PlanetScaleWebhookSetup />

			{/* The managed target's per-branch scrape health, via the shared scrape-target list. */}
			<ScrapeTargetsSection sourceFilter="planetscale" />

			{connectDialog}
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
