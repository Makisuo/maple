import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Exit } from "effect"
import {
	CloudflareStartConnectRequest,
	type CloudflareServiceUsage,
	type CloudflareUsageResponse,
} from "@maple/domain/http"
import { StatSparkline } from "@maple/ui/components/charts/sparkline/stat-sparkline"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { toast } from "sonner"

import { CircleWarningIcon, CloudflareIcon, LoaderIcon } from "@/components/icons"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { formatNumber, formatRelativeTime } from "@/lib/format"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { CLOUDFLARE_ACCENT, IntegrationIconPlate } from "./integration-catalog"
import { IntegrationEmptyState } from "./integration-empty-state"

const HOUR_MS = 3_600_000

/** Warehouse-derived ingest proof for one status row, precomputed for rendering. */
interface RowUsage {
	totalRequests: number
	lastDataAt: number | null
	/** Zero-filled hourly series over the usage window (StatSparkline plots `v`). */
	points: Array<{ v: number }>
}

/** Zero-fill the sparse hourly buckets across the whole window so gaps read as gaps. */
function fillHourlyPoints(
	usage: CloudflareUsageResponse,
	buckets: ReadonlyArray<{ bucketStart: number; requests: number }>,
): Array<{ v: number }> {
	const byStart = new Map(buckets.map((bucket) => [bucket.bucketStart, bucket.requests]))
	const first = Math.floor(usage.windowStart / HOUR_MS) * HOUR_MS
	const points: Array<{ v: number }> = []
	for (let t = first; t <= usage.windowEnd; t += HOUR_MS) {
		points.push({ v: byStart.get(t) ?? 0 })
	}
	return points
}

/** Merge one or more usage services into a single row readout (workers aggregate N scripts). */
function toRowUsage(
	usage: CloudflareUsageResponse,
	services: ReadonlyArray<CloudflareServiceUsage>,
): RowUsage {
	const summed = new Map<number, number>()
	let totalRequests = 0
	let lastDataAt: number | null = null
	for (const service of services) {
		totalRequests += service.totalRequests
		if (service.lastDataAt != null) {
			lastDataAt = lastDataAt == null ? service.lastDataAt : Math.max(lastDataAt, service.lastDataAt)
		}
		for (const bucket of service.buckets) {
			summed.set(bucket.bucketStart, (summed.get(bucket.bucketStart) ?? 0) + bucket.requests)
		}
	}
	const buckets = [...summed.entries()].map(([bucketStart, requests]) => ({ bucketStart, requests }))
	return { totalRequests, lastDataAt, points: fillHourlyPoints(usage, buckets) }
}

const relativeFromMs = (ms: number) => formatRelativeTime(new Date(ms).toISOString())

type CloudflareErrorTone = "error" | "warning"

interface CloudflareErrorInfo {
	/** Human-readable summary shown in the UI; falls back to the raw string when unrecognized. */
	summary: string
	tone: CloudflareErrorTone
	/**
	 * "account" errors break the whole integration and are fixed once (reconnect / retry),
	 * so they surface as a single banner. "resource" errors are per zone/worker and stay inline.
	 */
	scope: "account" | "resource"
}

/**
 * Turn a raw `lastError` (free-form, up to 500 chars from the poller / Cloudflare GraphQL) into a
 * friendly, legible readout. Known shapes get a plain-language summary; anything unrecognized falls
 * back to the raw text (still shown in full, never truncated). The raw string is always kept by the
 * caller for a "Details" tooltip so nothing is hidden.
 */
function describeCloudflareError(raw: string): CloudflareErrorInfo {
	const s = raw.toLowerCase()
	const has = (...needles: Array<string>) => needles.some((n) => s.includes(n))

	if (has("revoked", "no longer valid"))
		return { summary: "Cloudflare access was revoked — reconnect to resume.", tone: "error", scope: "account" }
	if (has("lacks the analytics scopes", "scope"))
		return { summary: "Reconnect to grant Maple analytics access.", tone: "warning", scope: "account" }
	if (has("cloudflare_oauth_client_id", "is required", "ingest key unavailable"))
		return {
			summary: "Traffic collection is temporarily unavailable — try again shortly.",
			tone: "error",
			scope: "account",
		}
	if (has("not authenticated", "not authorized", "unauthorized", "access denied"))
		return { summary: "Cloudflare denied the request — reconnect to refresh access.", tone: "error", scope: "account" }
	if (has("no longer present"))
		return { summary: "This zone was removed from your Cloudflare account.", tone: "warning", scope: "resource" }
	if (has("not enabled", "disabled"))
		return { summary: "Analytics isn't enabled for this zone in Cloudflare.", tone: "warning", scope: "resource" }
	if (has("unknown field", "cannot query"))
		return { summary: "Some analytics aren't available on this Cloudflare plan.", tone: "warning", scope: "resource" }

	return { summary: raw, tone: "error", scope: "resource" }
}

const isAccountScoped = (raw: string | null): boolean =>
	raw != null && describeCloudflareError(raw).scope === "account"

/** Small uppercase eyebrow that groups the readout (Zones / Workers). */
function SectionLabel({ children, count }: { children: ReactNode; count?: number }) {
	return (
		<div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
			<span>{children}</span>
			{count != null ? <span className="text-muted-foreground/50 tabular-nums">{count}</span> : null}
		</div>
	)
}

/** A resolved error line: friendly summary plus a "Details" tooltip carrying the raw string. */
function ErrorLine({ info, raw }: { info: CloudflareErrorInfo; raw: string }) {
	if (info.summary === raw) {
		return <span className="line-clamp-2 break-words">{raw}</span>
	}
	return (
		<span className="line-clamp-2 break-words">
			{info.summary}{" "}
			<Tooltip>
				<TooltipTrigger
					render={<span />}
					className="cursor-help font-medium underline decoration-dotted underline-offset-2"
				>
					Details
				</TooltipTrigger>
				<TooltipContent className="max-w-xs whitespace-pre-wrap break-words font-mono text-[11px]">
					{raw}
				</TooltipContent>
			</Tooltip>
		</span>
	)
}

interface StatusRowProps {
	name: string
	enabled: boolean
	lastSyncedAt: number | null
	lastError: string | null
	/** null = usage unavailable (loading/failed) — render poller state only. */
	usage: RowUsage | null
	/** True once the usage query resolved, so zero rows means "no data", not "still loading". */
	usageLoaded: boolean
	/** This row's failure is an account-wide one already shown in the banner — collapse it to "Paused". */
	accountPaused?: boolean
	indent?: boolean
}

/**
 * One zone/worker as a two-line flex row: status dot + name over a status detail line, with the
 * sparkline + request total right-aligned. The detail line wraps (errors are never clipped) — this
 * is the fix for the old fixed-width `truncate` cell that hid what actually went wrong.
 */
function StatusRow(props: StatusRowProps) {
	const { name, enabled, lastError, usage, usageLoaded, lastSyncedAt, accountPaused, indent } = props
	const hasData = usage != null && (usage.totalRequests > 0 || usage.lastDataAt != null)
	const err = lastError ? describeCloudflareError(lastError) : null
	const showInlineError = err != null && !accountPaused && err.scope === "resource"

	let dot = "bg-muted-foreground/40"
	let detail: ReactNode = null
	let detailClass = "text-muted-foreground"

	if (!enabled) {
		detail = "Disabled"
	} else if (accountPaused) {
		detail = "Paused"
	} else if (showInlineError && err && lastError) {
		dot = err.tone === "error" ? "bg-destructive" : "bg-warning"
		detailClass = err.tone === "error" ? "text-destructive-foreground" : "text-warning-foreground"
		detail = <ErrorLine info={err} raw={lastError} />
	} else if (hasData) {
		dot = "bg-success"
		detail = usage?.lastDataAt != null ? `Last data ${relativeFromMs(usage.lastDataAt)}` : "Receiving data"
	} else if (usageLoaded && lastSyncedAt) {
		dot = "bg-warning"
		detailClass = "text-warning-foreground"
		detail = "No data in last 24h"
	} else if (lastSyncedAt) {
		dot = "bg-success"
		detail = `Checked ${relativeFromMs(lastSyncedAt)}`
	} else {
		dot = "bg-warning"
		detailClass = "text-warning-foreground"
		detail = "Waiting for first data"
	}

	return (
		<div className="flex items-start gap-2.5 py-1">
			<span
				className={`mt-[5px] size-1.5 shrink-0 rounded-full ${indent ? "invisible" : dot}`}
				aria-hidden
			/>
			<div className="min-w-0 flex-1">
				<span
					className={`block truncate text-xs ${indent ? "pl-3 text-muted-foreground" : "font-medium text-foreground"}`}
					title={name}
				>
					{name}
				</span>
				<div className={`mt-0.5 text-[11px] ${indent ? "pl-3" : ""} ${detailClass}`}>{detail}</div>
			</div>
			<div className="flex shrink-0 items-center gap-3 pt-0.5">
				{hasData && usage ? (
					<StatSparkline data={usage.points} color={CLOUDFLARE_ACCENT} className="h-5 w-20" />
				) : null}
				<span className="w-14 text-right text-xs font-medium tabular-nums text-foreground">
					{hasData && usage ? formatNumber(usage.totalRequests) : null}
				</span>
			</div>
		</div>
	)
}

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
	const [showQuietZones, setShowQuietZones] = useState(false)
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
		return service ? toRowUsage(usage, [service]) : { totalRequests: 0, lastDataAt: null, points: [] }
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

	// One renderable entry per zone (poller state joined with warehouse usage), busiest
	// first. Accounts hold many parked domains, so zones that are healthy but saw zero
	// traffic collapse behind a toggle instead of drowning the live ones.
	interface ZoneEntry {
		key: string
		name: string
		enabled: boolean
		lastSyncedAt: number | null
		lastError: string | null
		usage: RowUsage | null
	}
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
	const isQuietZone = (entry: ZoneEntry) =>
		usageLoaded &&
		entry.enabled &&
		entry.lastError == null &&
		entry.usage != null &&
		entry.usage.totalRequests === 0 &&
		entry.usage.lastDataAt == null
	const byTraffic = (a: ZoneEntry, b: ZoneEntry) =>
		(b.usage?.totalRequests ?? 0) - (a.usage?.totalRequests ?? 0)
	const activeZones = zoneEntries.filter((entry) => !isQuietZone(entry)).sort(byTraffic)
	const quietZones = zoneEntries.filter(isQuietZone).sort((a, b) => a.name.localeCompare(b.name))

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
					"Zone traffic analytics, streamed in",
					"Workers request volume across every script",
					"Nothing to configure in the Cloudflare dashboard",
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
	const zoneCount = activeZones.length + quietZones.length
	const hasWorkers = status?.workers != null || workerServices.length > 0

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
								<div className="flex flex-col gap-0.5">
									<SectionLabel count={zoneCount}>Zones</SectionLabel>
									{activeZones.map((entry) => (
										<StatusRow
											key={entry.key}
											name={entry.name}
											enabled={entry.enabled}
											lastSyncedAt={entry.lastSyncedAt}
											lastError={entry.lastError}
											usage={entry.usage}
											usageLoaded={usageLoaded}
											accountPaused={isAccountScoped(entry.lastError)}
										/>
									))}
									{showQuietZones
										? quietZones.map((entry) => (
												<StatusRow
													key={entry.key}
													name={entry.name}
													enabled={entry.enabled}
													lastSyncedAt={entry.lastSyncedAt}
													lastError={entry.lastError}
													usage={entry.usage}
													usageLoaded={usageLoaded}
													accountPaused={isAccountScoped(entry.lastError)}
												/>
											))
										: null}
									{quietZones.length > 0 ? (
										<button
											type="button"
											onClick={() => setShowQuietZones((v) => !v)}
											className="mt-1 w-fit cursor-pointer text-left text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground"
										>
											{showQuietZones
												? "Hide zones with no data"
												: `Show ${quietZones.length} more ${quietZones.length === 1 ? "zone" : "zones"} · no data in last 24h`}
										</button>
									) : null}
								</div>
							) : null}

							{hasWorkers ? (
								<div className="flex flex-col gap-0.5">
									<SectionLabel>Workers</SectionLabel>
									<StatusRow
										name="Workers"
										enabled={status.workers?.enabled ?? true}
										lastSyncedAt={status.workers?.lastSyncedAt ?? null}
										lastError={status.workers?.lastError ?? null}
										usage={
											usage
												? (workersRowUsage ?? {
														totalRequests: 0,
														lastDataAt: null,
														points: [],
													})
												: null
										}
										usageLoaded={usageLoaded}
										accountPaused={isAccountScoped(status.workers?.lastError ?? null)}
									/>
									{usage && workerServices.length > 1
										? [...workerServices]
												.sort((a, b) => b.totalRequests - a.totalRequests)
												.map((service) => (
													<StatusRow
														key={service.serviceName}
														name={service.displayName}
														enabled={true}
														lastSyncedAt={null}
														lastError={null}
														usage={toRowUsage(usage, [service])}
														usageLoaded={usageLoaded}
														indent
													/>
												))
										: null}
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
