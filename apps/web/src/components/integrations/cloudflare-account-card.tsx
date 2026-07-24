import { useMemo, useState } from "react"
import { Exit } from "effect"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { toast } from "sonner"

import { CircleWarningIcon, CloudflareIcon, LoaderIcon } from "@/components/icons"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { CLOUDFLARE_ACCENT, IntegrationIconPlate } from "./integration-catalog"
import { useIntegrationConnect } from "./integration-connect"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyFooter,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"
import { CloudflareStatCards } from "./cloudflare-stat-cards"
import {
	CloudflareWorkersCard,
	CloudflareZoneBoard,
	describeCloudflareError,
	isAccountScoped,
	toRowUsage,
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

	// Warehouse-derived ingest volume: loads independently so the card renders instantly
	// from status and the usage columns hydrate (or silently stay absent) afterwards.
	const usageQuery = MapleApiAtomClient.query("integrations", "cloudflareUsage", {
		reactivityKeys: ["cloudflareIntegrationUsage"],
	})
	const usageResult = useAtomValue(usageQuery)

	// Connect flow (popup, busy, refresh-on-return) lives in IntegrationConnectProvider —
	// shared with the drill-in header's Connect/Reconnect/Disconnect buttons.
	const connectFlow = useIntegrationConnect()
	if (connectFlow === null) {
		throw new Error("CloudflareAccountCard must be rendered inside IntegrationConnectProvider")
	}
	const actionBusy = connectFlow.busy

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() => null)

	// A failed usage fetch degrades to the poller-only view — never an error box
	// over what is decoration on top of the status readout.
	const usage = Result.builder(usageResult)
		.onSuccess((u) => u)
		.orElse(() => null)
	const usageLoaded = usage != null
	// Failure ≠ still-loading: the stat band hides entirely instead of skeleton-ing forever.
	const usageFailed = Result.isFailure(usageResult)

	const workerServices = useMemo(
		() => (usage ? usage.services.filter((service) => service.kind === "worker") : []),
		[usage],
	)
	const workersRowUsage = usage && workerServices.length > 0 ? toRowUsage(usage, workerServices) : null

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
		return usage.services.filter((service) => service.kind === "zone" && !known.has(service.displayName))
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

	const isConnected = status?.connected === true

	const connectButton = (label: string, variant?: "outline") => (
		<Button size="sm" onClick={connectFlow.connect} disabled={actionBusy} variant={variant}>
			{connectFlow.busy ? <LoaderIcon size={14} className="animate-spin" /> : null}
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
			<IntegrationEmpty icon={CloudflareIcon} accent={CLOUDFLARE_ACCENT}>
				<IntegrationEmptyFeatures>
					<IntegrationEmptyFeature
						label="Zone analytics"
						title="Requests & cache per zone"
						description="Traffic, cache hit rate, and errors for every zone under Infrastructure."
					/>
					<IntegrationEmptyFeature
						label="Workers"
						title="Scripts on the service map"
						description="Every Worker appears as a node with request volume and errors wired into traces."
					/>
					<IntegrationEmptyFeature
						label="DNS & security"
						title="Firewall events with context"
						description="DNS records, hosts, and WAF activity land alongside your traces and logs."
					/>
				</IntegrationEmptyFeatures>
				<IntegrationEmptyCard>
					<IntegrationEmptyMedia />
					<IntegrationEmptyHint>
						Your zones and Workers will appear here after connecting.
					</IntegrationEmptyHint>
					<Button onClick={connectFlow.connect} disabled={actionBusy}>
						{connectFlow.busy ? (
							<LoaderIcon size={16} className="animate-spin" />
						) : (
							<CloudflareIcon size={16} />
						)}
						Connect Cloudflare
					</Button>
					<IntegrationEmptyFooter>
						Read-only OAuth · takes about a minute · disconnect anytime
					</IntegrationEmptyFooter>
				</IntegrationEmptyCard>
			</IntegrationEmpty>
		)
	}

	const hasReadout =
		status != null &&
		(status.zones.length > 0 || status.workers != null || (usage != null && usage.services.length > 0))
	const zoneCount = zoneEntries.length
	const hasWorkers = status?.workers != null || workerServices.length > 0

	// Aggregate Workers state in the zone-entry shape so the side card's problem line
	// derives from the same `zoneStatus` rules as zone rows.
	const workerEntry: ZoneEntry = {
		key: "workers",
		name: "Workers",
		enabled: status?.workers?.enabled ?? true,
		lastSyncedAt: status?.workers?.lastSyncedAt ?? null,
		lastError: status?.workers?.lastError ?? null,
		usage: usage ? (workersRowUsage ?? { ...EMPTY_USAGE }) : null,
	}

	// One banner for the whole-account problem — the actionable "what's wrong + how to
	// fix". Lives inside the Zones card (the resources it pauses); standalone when there
	// are no zones to attach it to.
	const banner =
		status == null ? null : !status.analyticsCapable ? (
			<Alert variant="warning">
				<CircleWarningIcon />
				<AlertTitle>Update access to collect analytics</AlertTitle>
				<AlertDescription>
					Maple needs updated Cloudflare permissions to read traffic analytics from this account.
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
		) : null

	return (
		<div className="flex flex-col gap-4">
			{hasReadout ? (
				<>
					{!usageFailed ? (
						<CloudflareStatCards usage={usage} workerServices={workerServices} />
					) : null}
					{zoneCount === 0 && banner}
					<div className="flex flex-col gap-4 lg:flex-row lg:items-start">
						{zoneCount > 0 ? (
							<CloudflareZoneBoard
								zones={zoneEntries}
								usageLoaded={usageLoaded}
								banner={banner}
								className="min-w-0 flex-1"
							/>
						) : null}
						{hasWorkers ? (
							<CloudflareWorkersCard
								workerEntry={workerEntry}
								workerServices={workerServices}
								usageLoaded={usageLoaded}
								className="lg:w-72 lg:shrink-0 xl:w-80"
							/>
						) : null}
					</div>
				</>
			) : (
				<>
					{banner}
					<p className="text-xs text-muted-foreground">
						Traffic data starts arriving within a few minutes — your zones and Workers will
						appear here.
					</p>
				</>
			)}
		</div>
	)
}

/**
 * Reconnect + Disconnect for the drill-in page header — rendered by the route when the
 * integration is connected, replacing the account card's old header band. Must live
 * inside IntegrationConnectProvider (same popup flow as Connect).
 */
export function CloudflareHeaderActions() {
	const connectFlow = useIntegrationConnect()
	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "cloudflareDisconnect"), {
		mode: "promiseExit",
	})
	const [disconnectBusy, setDisconnectBusy] = useState(false)
	if (connectFlow === null) {
		throw new Error("CloudflareHeaderActions must be rendered inside IntegrationConnectProvider")
	}
	const actionBusy = connectFlow.busy || disconnectBusy

	async function handleDisconnect() {
		setDisconnectBusy(true)
		const result = await disconnect({
			reactivityKeys: ["cloudflareIntegrationStatus", "cloudflareIntegrationUsage"],
		})
		setDisconnectBusy(false)
		if (Exit.isSuccess(result)) {
			toast.success("Cloudflare account disconnected")
		} else {
			toast.error("Failed to disconnect Cloudflare account")
		}
	}

	return (
		<div className="flex items-center gap-2">
			<Button size="sm" variant="outline" onClick={connectFlow.connect} disabled={actionBusy}>
				{connectFlow.busy ? <LoaderIcon size={14} className="animate-spin" /> : null}
				Reconnect
			</Button>
			<Button
				size="sm"
				variant="outline"
				onClick={handleDisconnect}
				disabled={actionBusy}
				className="border-destructive/40 text-destructive-foreground hover:bg-destructive/10 hover:text-destructive-foreground"
			>
				{disconnectBusy ? <LoaderIcon size={14} className="animate-spin" /> : null}
				Disconnect
			</Button>
		</div>
	)
}
