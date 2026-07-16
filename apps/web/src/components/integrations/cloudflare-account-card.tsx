import { useEffect, useMemo, useRef, useState } from "react"
import { Exit } from "effect"
import { CloudflareStartConnectRequest } from "@maple/domain/http"
import { StatSparkline } from "@maple/ui/components/charts/sparkline/stat-sparkline"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { toast } from "sonner"

import {
	BoltIcon,
	CircleWarningIcon,
	CloudflareIcon,
	GlobeIcon,
	LoaderIcon,
	ShieldIcon,
} from "@/components/icons"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { formatNumber } from "@/lib/format"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { CLOUDFLARE_ACCENT, IntegrationIconPlate } from "./integration-catalog"
import { IntegrationEmptyState } from "./integration-empty-state"
import {
	CloudflareZoneBoard,
	ResourceRow,
	SectionLabel,
	describeCloudflareError,
	isAccountScoped,
	toRowUsage,
	zoneStatus,
	type CloudflareErrorInfo,
	type RowUsage,
	type ZoneEntry,
} from "./cloudflare-zone-board"

const EMPTY_USAGE: RowUsage = { totalRequests: 0, lastDataAt: null, points: [] }

/**
 * Account-level Cloudflare OAuth connection (Authorization Code + PKCE). Distinct from the
 * Logpush connectors below it on the page: this authorizes Maple against the customer's
 * Cloudflare account so later phases can auto-provision telemetry (Workers traces/logs,
 * Logpush jobs) instead of the manual copy-paste setup.
 */
export function CloudflareAccountCard() {
	// Assigned once so the refresh hooks target the same memoized query atoms.
	const statusQuery = MapleApiAtomClient.query("integrations", "cloudflareStatus", {
		reactivityKeys: ["cloudflareIntegrationStatus"],
	})
	const statusResult = useAtomValue(statusQuery)
	const refreshStatus = useAtomRefresh(statusQuery)

	// Warehouse-derived ingest volume: loads independently so the card renders instantly
	// from status and the usage columns hydrate (or silently stay absent) afterwards.
	const usageQuery = MapleApiAtomClient.query("integrations", "cloudflareUsage", {
		reactivityKeys: ["cloudflareIntegrationUsage"],
	})
	const usageResult = useAtomValue(usageQuery)
	const refreshUsage = useAtomRefresh(usageQuery)

	const startConnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "cloudflareStart"), {
		mode: "promiseExit",
	})
	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "cloudflareDisconnect"), {
		mode: "promiseExit",
	})

	const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null)
	const popupRef = useRef<Window | null>(null)
	const [popupOpen, setPopupOpen] = useState(false)

	// The OAuth popup returns to this same SPA and posts a success message before closing —
	// refresh status (and usage) so the card flips to Connected without a manual page reload.
	useEffect(() => {
		function onMessage(event: MessageEvent) {
			if (event.data?.type === "maple:integration:cloudflare") {
				if (event.data.status === "success") {
					toast.success("Cloudflare account connected")
					refreshStatus()
					refreshUsage()
				} else if (event.data.status === "error") {
					toast.error(event.data.message ?? "Cloudflare connection failed")
				}
			}
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [refreshStatus, refreshUsage])

	// Cross-origin popups fire no "closed" event, so poll the handle. When it closes,
	// refresh immediately — covers the case where the success message never arrives
	// (popup closed manually or blocked) so the card can't get stuck on the stale view.
	useEffect(() => {
		if (!popupOpen) return
		const id = setInterval(() => {
			if (popupRef.current?.closed ?? true) {
				popupRef.current = null
				setPopupOpen(false)
				refreshStatus()
				refreshUsage()
			}
		}, 500)
		return () => clearInterval(id)
	}, [popupOpen, refreshStatus, refreshUsage])

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() => null)

	// A failed usage fetch degrades to the poller-only view — never an error box
	// over what is decoration on top of the status readout.
	const usage = Result.builder(usageResult)
		.onSuccess((u) => u)
		.orElse(() => null)
	const usageLoaded = usage != null

	const workerServices = useMemo(
		() => (usage ? usage.services.filter((service) => service.kind === "worker") : []),
		[usage],
	)
	const workersRowUsage = usage && workerServices.length > 0 ? toRowUsage(usage, workerServices) : null
	const totalPoints = useMemo(
		() => (usage && usage.totalRequests > 0 ? toRowUsage(usage, usage.services).points : null),
		[usage],
	)

	const zoneUsage = (zoneName: string): RowUsage | null => {
		if (!usage) return null
		const service = usage.services.find((s) => s.kind === "zone" && s.displayName === zoneName)
		return service ? toRowUsage(usage, [service]) : { ...EMPTY_USAGE }
	}

	// Zones the warehouse has data for but the poller has no state row yet (discovery
	// lag, or data arriving via Logpush) — still proof the integration works, so list them.
	const unmatchedZoneServices = useMemo(() => {
		if (!usage || !status) return []
		const known = new Set(status.zones.map((zone) => zone.name))
		return usage.services.filter(
			(service) => service.kind === "zone" && !known.has(service.displayName),
		)
	}, [usage, status])

	// The first account-wide failure across zones/workers (revoked token, missing config, denied
	// auth). Surfaced once as a banner instead of repeated — and unreadable — on every row.
	const accountError = useMemo((): (CloudflareErrorInfo & { raw: string }) | null => {
		if (!status) return null
		const raws = [status.workers?.lastError ?? null, ...status.zones.map((z) => z.lastError)]
		for (const raw of raws) {
			if (raw && isAccountScoped(raw)) return { ...describeCloudflareError(raw), raw }
		}
		return null
	}, [status])

	// One renderable entry per zone (poller state joined with warehouse usage). The board owns
	// searching, status filtering, sorting, and the bounded scroll — this just assembles the set.
	const zoneEntries: Array<ZoneEntry> = (status?.zones ?? []).map((zone) => ({
		key: zone.id,
		name: zone.name,
		enabled: zone.enabled,
		lastSyncedAt: zone.lastSyncedAt,
		lastError: zone.lastError,
		usage: zoneUsage(zone.name),
	}))
	for (const service of unmatchedZoneServices) {
		zoneEntries.push({
			key: service.serviceName,
			name: service.displayName,
			enabled: true,
			lastSyncedAt: null,
			lastError: null,
			usage: usage ? toRowUsage(usage, [service]) : null,
		})
	}

	async function handleConnect() {
		// Open the popup synchronously (inside the click) so the browser doesn't block it,
		// then point it at the authorize URL once the start call returns.
		const popup = window.open("", "maple-cloudflare-connect", "popup,width=520,height=680")
		popupRef.current = popup
		if (popup) setPopupOpen(true)
		setBusy("connect")
		const result = await startConnect({
			payload: new CloudflareStartConnectRequest({ returnTo: window.location.href }),
			reactivityKeys: ["cloudflareIntegrationStatus"],
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			const url = result.value.redirectUrl
			if (popup && !popup.closed) {
				popup.location.href = url
			} else {
				const reopened = window.open(url, "maple-cloudflare-connect", "popup,width=520,height=680")
				popupRef.current = reopened
				if (reopened) setPopupOpen(true)
			}
		} else {
			popup?.close()
			popupRef.current = null
			setPopupOpen(false)
			toast.error("Failed to start Cloudflare connect flow")
		}
	}

	async function handleDisconnect() {
		setBusy("disconnect")
		const result = await disconnect({
			reactivityKeys: ["cloudflareIntegrationStatus", "cloudflareIntegrationUsage"],
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			toast.success("Cloudflare account disconnected")
		} else {
			toast.error("Failed to disconnect Cloudflare account")
		}
	}

	const isConnected = status?.connected === true

	const connectButton = (label: string, variant?: "outline") => (
		<Button size="sm" onClick={handleConnect} disabled={busy !== null} variant={variant}>
			{busy === "connect" ? <LoaderIcon size={14} className="animate-spin" /> : null}
			{label}
		</Button>
	)

	// Guard the first fetch so a connected org doesn't flash the "Connect" empty state.
	if (Result.isInitial(statusResult)) {
		return <Skeleton className="h-40 w-full rounded-lg" />
	}

	// A failed status fetch is not "not connected" — don't offer the connect CTA
	// over an account that may already be authorized.
	if (Result.isFailure(statusResult)) {
		return (
			<div className="flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4">
				<IntegrationIconPlate icon={CloudflareIcon} accent={CLOUDFLARE_ACCENT} />
				<div className="flex flex-col gap-1">
					<h3 className="text-sm font-semibold">Cloudflare account</h3>
					<p className="text-xs text-muted-foreground">
						Couldn't load the Cloudflare connection status — refresh the page to try again.
					</p>
				</div>
			</div>
		)
	}

	if (!isConnected) {
		return (
			<IntegrationEmptyState
				icon={CloudflareIcon}
				accent={CLOUDFLARE_ACCENT}
				title="Connect your Cloudflare account"
				description="See traffic and Workers analytics from your Cloudflare account in Maple — connect once, nothing to configure in the Cloudflare dashboard."
				features={[
					{
						icon: GlobeIcon,
						title: "Zone analytics",
						description: "Traffic, cache hit rate, and errors for every zone under Infrastructure.",
					},
					{
						icon: BoltIcon,
						title: "Workers on the map",
						description: "Scripts join the service map with request volume and errors.",
					},
					{
						icon: ShieldIcon,
						title: "DNS & security",
						description: "DNS records, hosts, and WAF activity per zone.",
					},
				]}
				footer="You'll authorize Maple in a Cloudflare popup."
			>
				<Button onClick={handleConnect} disabled={busy !== null}>
					{busy === "connect" ? (
						<LoaderIcon size={16} className="animate-spin" />
					) : (
						<CloudflareIcon size={16} />
					)}
					Connect Cloudflare
				</Button>
			</IntegrationEmptyState>
		)
	}

	const hasReadout =
		status != null &&
		(status.zones.length > 0 || status.workers != null || (usage != null && usage.services.length > 0))
	const zoneCount = zoneEntries.length
	const hasWorkers = status?.workers != null || workerServices.length > 0

	// Aggregate the Workers scripts into one health row, mirroring the zone entry shape so the
	// same ResourceRow + zoneStatus drive it. Sub-scripts nest below when there's more than one.
	const workerEntry: ZoneEntry = {
		key: "workers",
		name: "Workers",
		enabled: status?.workers?.enabled ?? true,
		lastSyncedAt: status?.workers?.lastSyncedAt ?? null,
		lastError: status?.workers?.lastError ?? null,
		usage: usage ? (workersRowUsage ?? { ...EMPTY_USAGE }) : null,
	}

	return (
		<div className="overflow-hidden rounded-lg border border-border/60 bg-card">
			{/* Header band: identity + connection status, with the account actions to the right. */}
			<div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 p-4">
				<div className="flex min-w-0 items-start gap-3">
					<IntegrationIconPlate icon={CloudflareIcon} accent={CLOUDFLARE_ACCENT} />
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h3 className="text-sm font-semibold">Cloudflare account</h3>
							<Badge variant="success">Connected</Badge>
						</div>
						<p className="mt-1 text-xs text-muted-foreground">
							{status?.accountName ? (
								<>
									Streaming from{" "}
									<span
										className="font-medium text-foreground"
										title={status.accountId ?? undefined}
									>
										{status.accountName}
									</span>
									{" — zone and Workers traffic flows into Maple."}
								</>
							) : (
								"Zone and Workers traffic flows into Maple."
							)}
						</p>
					</div>
				</div>

				<div className="flex shrink-0 items-center gap-1.5">
					{connectButton("Reconnect", "outline")}
					<Button size="sm" onClick={handleDisconnect} disabled={busy !== null} variant="outline">
						{busy === "disconnect" ? <LoaderIcon size={14} className="animate-spin" /> : null}
						Disconnect
					</Button>
				</div>
			</div>

			{status ? (
				<div className="flex flex-col gap-4 p-4">
					{/* One banner for the whole-account problem — the actionable "what's wrong + how to fix". */}
					{!status.analyticsCapable ? (
						<Alert variant="warning">
							<CircleWarningIcon />
							<AlertTitle>Update access to collect analytics</AlertTitle>
							<AlertDescription>
								Maple needs updated Cloudflare permissions to read traffic analytics from this
								account.
							</AlertDescription>
							<AlertAction>{connectButton("Update access")}</AlertAction>
						</Alert>
					) : accountError ? (
						<Alert variant={accountError.tone}>
							<CircleWarningIcon />
							<AlertTitle>Traffic collection paused</AlertTitle>
							<AlertDescription>
								<span>{accountError.summary}</span>
								{accountError.summary !== accountError.raw ? (
									<Tooltip>
										<TooltipTrigger
											render={<span />}
											className="w-fit cursor-help text-xs font-medium text-muted-foreground underline decoration-dotted underline-offset-2"
										>
											Error details
										</TooltipTrigger>
										<TooltipContent className="max-w-xs whitespace-pre-wrap break-words font-mono text-[11px]">
											{accountError.raw}
										</TooltipContent>
									</Tooltip>
								) : null}
							</AlertDescription>
							<AlertAction>{connectButton("Reconnect", "outline")}</AlertAction>
						</Alert>
					) : null}

					{hasReadout ? (
						<>
							{/* Aggregate is the hero of the readout: the 24h request shape at a glance. */}
							{usage && usage.totalRequests > 0 ? (
								<div className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2.5">
									<div className="min-w-0">
										<div className="text-xs font-medium text-foreground">Traffic</div>
										<div className="text-[11px] text-muted-foreground">
											Requests · last 24h
										</div>
									</div>
									<div className="flex shrink-0 items-center gap-3">
										{totalPoints ? (
											<StatSparkline
												data={totalPoints}
												color={CLOUDFLARE_ACCENT}
												className="h-7 w-28"
											/>
										) : null}
										<span className="w-16 text-right text-sm font-semibold tabular-nums text-foreground">
											{formatNumber(usage.totalRequests)}
										</span>
									</div>
								</div>
							) : null}

							{zoneCount > 0 ? (
								<CloudflareZoneBoard zones={zoneEntries} usageLoaded={usageLoaded} />
							) : null}

							{hasWorkers ? (
								<div className="flex flex-col gap-2">
									<SectionLabel>Workers</SectionLabel>
									<div className="overflow-hidden rounded-lg border border-border/60">
										<ResourceRow
											name="Workers"
											status={zoneStatus(workerEntry, usageLoaded)}
											usage={workerEntry.usage}
										/>
										{usage && workerServices.length > 1
											? [...workerServices]
													.sort((a, b) => b.totalRequests - a.totalRequests)
													.map((service) => {
														const scriptUsage = toRowUsage(usage, [service])
														const scriptEntry: ZoneEntry = {
															key: service.serviceName,
															name: service.displayName,
															enabled: true,
															lastSyncedAt: null,
															lastError: null,
															usage: scriptUsage,
														}
														return (
															<ResourceRow
																key={service.serviceName}
																name={service.displayName}
																status={zoneStatus(scriptEntry, usageLoaded)}
																usage={scriptUsage}
																indent
															/>
														)
													})
											: null}
									</div>
								</div>
							) : null}
						</>
					) : (
						<p className="text-xs text-muted-foreground">
							Traffic data starts arriving within a few minutes — your zones and Workers will
							appear here.
						</p>
					)}
				</div>
			) : null}
		</div>
	)
}
