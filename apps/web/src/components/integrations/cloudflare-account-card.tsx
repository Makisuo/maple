import { useEffect, useMemo, useState } from "react"
import { Exit } from "effect"
import {
	CloudflareStartConnectRequest,
	type CloudflareServiceUsage,
	type CloudflareUsageResponse,
} from "@maple/domain/http"
import { StatSparkline } from "@maple/ui/components/charts/sparkline/stat-sparkline"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toast } from "sonner"

import { CloudflareIcon, LoaderIcon } from "@/components/icons"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
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

function CollectionStatusRow(props: {
	name: string
	enabled: boolean
	lastSyncedAt: number | null
	lastError: string | null
	watermarkAt?: number | null
	/** null = usage unavailable (loading/failed) — render poller state only. */
	usage: RowUsage | null
	/** True once the usage query resolved, so zero rows means "no data", not "still loading". */
	usageLoaded: boolean
	indent?: boolean
}) {
	const hasData = props.usage != null && (props.usage.totalRequests > 0 || props.usage.lastDataAt != null)
	const dotClass = !props.enabled
		? "bg-muted-foreground/40"
		: props.lastError
			? "bg-destructive"
			: hasData
				? "bg-emerald-500"
				: props.usageLoaded && props.lastSyncedAt
					? "bg-amber-500"
					: props.lastSyncedAt
						? "bg-emerald-500"
						: "bg-amber-500"
	const detail = !props.enabled
		? "disabled"
		: (props.lastError ??
			(props.usage?.lastDataAt != null
				? `last data ${relativeFromMs(props.usage.lastDataAt)}`
				: props.usageLoaded && props.lastSyncedAt
					? "no data in last 24h"
					: props.lastSyncedAt
						? `checked ${relativeFromMs(props.lastSyncedAt)}`
						: "waiting for first data"))
	const detailClass =
		props.enabled && !props.lastError && !hasData && props.usageLoaded && props.lastSyncedAt
			? "text-amber-600 dark:text-amber-400"
			: "text-muted-foreground"

	const tooltip = [
		props.lastError,
		props.usage?.lastDataAt != null ? `Last data: ${new Date(props.usage.lastDataAt).toLocaleString()}` : null,
		props.watermarkAt != null ? `Ingested up to: ${new Date(props.watermarkAt).toLocaleString()}` : null,
		props.lastSyncedAt != null ? `Last checked: ${new Date(props.lastSyncedAt).toLocaleString()}` : null,
	]
		.filter(Boolean)
		.join("\n")

	// Cells of the shared analytics grid (via display:contents) — every row's name,
	// sparkline, total, and detail sit on the same column tracks, so nothing drifts.
	const title = tooltip.length > 0 ? tooltip : undefined
	return (
		<div className="contents">
			<span className="flex size-1.5 items-center">
				{props.indent ? null : <span className={`size-1.5 rounded-full ${dotClass}`} />}
			</span>
			<span
				className={`min-w-0 truncate ${props.indent ? "pl-3 text-muted-foreground" : "text-foreground"}`}
				title={title}
			>
				{props.name}
			</span>
			<span className="h-4 w-24">
				{hasData && props.usage ? (
					<StatSparkline data={props.usage.points} color={CLOUDFLARE_ACCENT} className="h-4 w-24" />
				) : null}
			</span>
			<span className="text-right font-medium text-foreground tabular-nums">
				{hasData && props.usage ? formatNumber(props.usage.totalRequests) : null}
			</span>
			<span className={`truncate text-right ${detailClass}`} title={title}>
				{detail}
			</span>
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
	const statusResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "cloudflareStatus", {
			reactivityKeys: ["cloudflareIntegrationStatus"],
		}),
	)

	// Warehouse-derived ingest volume: loads independently so the card renders instantly
	// from status and the usage columns hydrate (or silently stay absent) afterwards.
	const usageResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "cloudflareUsage", {
			reactivityKeys: ["cloudflareIntegrationUsage"],
		}),
	)

	const startConnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "cloudflareStart"), {
		mode: "promiseExit",
	})
	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "cloudflareDisconnect"), {
		mode: "promiseExit",
	})

	const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null)
	const [showQuietZones, setShowQuietZones] = useState(false)

	useEffect(() => {
		function onMessage(event: MessageEvent) {
			if (event.data?.type === "maple:integration:cloudflare") {
				if (event.data.status === "success") {
					toast.success("Cloudflare account connected")
				} else if (event.data.status === "error") {
					toast.error(event.data.message ?? "Cloudflare connection failed")
				}
			}
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [])

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

	// One renderable entry per zone (poller state joined with warehouse usage), busiest
	// first. Accounts hold many parked domains, so zones that are healthy but saw zero
	// traffic collapse behind a toggle instead of drowning the live ones.
	interface ZoneEntry {
		key: string
		name: string
		enabled: boolean
		lastSyncedAt: number | null
		lastError: string | null
		watermarkAt: number | null
		usage: RowUsage | null
	}
	const zoneEntries: Array<ZoneEntry> = (status?.zones ?? []).map((zone) => ({
		key: zone.id,
		name: zone.name,
		enabled: zone.enabled,
		lastSyncedAt: zone.lastSyncedAt,
		lastError: zone.lastError,
		watermarkAt: zone.watermarkAt,
		usage: zoneUsage(zone.name),
	}))
	for (const service of unmatchedZoneServices) {
		zoneEntries.push({
			key: service.serviceName,
			name: service.displayName,
			enabled: true,
			lastSyncedAt: null,
			lastError: null,
			watermarkAt: null,
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
		setBusy("connect")
		const result = await startConnect({
			payload: new CloudflareStartConnectRequest({ returnTo: window.location.href }),
			reactivityKeys: ["cloudflareIntegrationStatus"],
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			const url = result.value.redirectUrl
			if (popup) popup.location.href = url
			else window.open(url, "maple-cloudflare-connect", "popup,width=520,height=680")
		} else {
			popup?.close()
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

	return (
		<div className="flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4">
			<IntegrationIconPlate icon={CloudflareIcon} accent={CLOUDFLARE_ACCENT} />

			<div className="flex flex-1 flex-col gap-2">
				<div>
					<div className="flex items-center gap-2">
						<h3 className="text-sm font-semibold">Cloudflare account</h3>
						<Badge variant="success">Connected</Badge>
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{status?.accountName ? (
							<>
								Connected to{" "}
								<span
									className="font-medium text-foreground"
									title={status.accountId ?? undefined}
								>
									{status.accountName}
								</span>{" "}
								— traffic from your zones and Workers streams into Maple.
							</>
						) : (
							"Connected — traffic from your zones and Workers streams into Maple."
						)}
					</p>
				</div>

				{status ? (
					<>
						{!status.analyticsCapable ? (
							<div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px]">
								<span className="text-amber-600 dark:text-amber-400">
									Maple needs updated access to collect traffic analytics from this account.
								</span>
								{connectButton("Update access")}
							</div>
						) : status.zones.length > 0 ||
						  status.workers ||
						  (usage != null && usage.services.length > 0) ? (
							<div className="grid grid-cols-[auto_minmax(0,1fr)_6rem_3.5rem_8rem] items-center gap-x-3 gap-y-1.5 rounded-md bg-muted/40 px-3 py-2 text-[11px]">
								{/* Header shares the grid tracks so the aggregate lines up with the rows below. */}
								{usage && usage.totalRequests > 0 ? (
									<>
										<span className="col-span-2 truncate font-medium text-muted-foreground">
											Traffic
										</span>
										<span className="h-5 w-24">
											{totalPoints ? (
												<StatSparkline
													data={totalPoints}
													color={CLOUDFLARE_ACCENT}
													className="h-5 w-24"
												/>
											) : null}
										</span>
										<span className="text-right font-medium text-foreground tabular-nums">
											{formatNumber(usage.totalRequests)}
										</span>
										<span className="text-right text-muted-foreground">requests · 24h</span>
									</>
								) : (
									<span className="col-span-5 truncate font-medium text-muted-foreground">
										Traffic
									</span>
								)}
								{activeZones.map((entry) => (
									<CollectionStatusRow
										key={entry.key}
										name={entry.name}
										enabled={entry.enabled}
										lastSyncedAt={entry.lastSyncedAt}
										lastError={entry.lastError}
										watermarkAt={entry.watermarkAt}
										usage={entry.usage}
										usageLoaded={usageLoaded}
									/>
								))}
								{showQuietZones
									? quietZones.map((entry) => (
											<CollectionStatusRow
												key={entry.key}
												name={entry.name}
												enabled={entry.enabled}
												lastSyncedAt={entry.lastSyncedAt}
												lastError={entry.lastError}
												watermarkAt={entry.watermarkAt}
												usage={entry.usage}
												usageLoaded={usageLoaded}
											/>
										))
									: null}
								{quietZones.length > 0 ? (
									<button
										type="button"
										onClick={() => setShowQuietZones((v) => !v)}
										className="col-span-5 w-fit cursor-pointer text-left text-muted-foreground/70 transition-colors hover:text-muted-foreground"
									>
										{showQuietZones
											? "Hide zones with no data"
											: `Show ${quietZones.length} more ${quietZones.length === 1 ? "zone" : "zones"} · no data in last 24h`}
									</button>
								) : null}
								{status.workers || workerServices.length > 0 ? (
									<>
										<CollectionStatusRow
											name="Workers"
											enabled={status.workers?.enabled ?? true}
											lastSyncedAt={status.workers?.lastSyncedAt ?? null}
											lastError={status.workers?.lastError ?? null}
											watermarkAt={status.workers?.watermarkAt}
											usage={usage ? (workersRowUsage ?? { totalRequests: 0, lastDataAt: null, points: [] }) : null}
											usageLoaded={usageLoaded}
										/>
										{usage && workerServices.length > 1
											? [...workerServices]
													.sort((a, b) => b.totalRequests - a.totalRequests)
													.map((service) => (
													<CollectionStatusRow
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
									</>
								) : null}
							</div>
						) : (
							<p className="text-[11px] text-muted-foreground">
								Traffic data starts arriving within a few minutes — your zones will appear here.
							</p>
						)}
					</>
				) : null}

				<div className="flex flex-wrap gap-2">
					{connectButton("Reconnect", "outline")}
					<Button size="sm" onClick={handleDisconnect} disabled={busy !== null} variant="outline">
						{busy === "disconnect" ? <LoaderIcon size={14} className="animate-spin" /> : null}
						Disconnect
					</Button>
				</div>
			</div>
		</div>
	)
}
