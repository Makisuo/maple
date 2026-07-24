import { useMemo, useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import type { CloudflareServiceUsage, CloudflareUsageResponse } from "@maple/domain/http"
import { StatSparkline } from "@maple/ui/components/charts/sparkline/stat-sparkline"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@maple/ui/components/ui/input-group"
import { cn } from "@maple/ui/lib/utils"

import { ColumnHead, type SortDir } from "@/components/infra/primitives/data-table"
import { MagnifierIcon, XmarkIcon } from "@/components/icons"
import { formatNumber, formatRelativeTime } from "@/lib/format"
import { CLOUDFLARE_ACCENT } from "./integration-catalog"

const HOUR_MS = 3_600_000

/** Warehouse-derived ingest proof for one status row, precomputed for rendering. */
export interface RowUsage {
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
export function toRowUsage(
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

export interface CloudflareErrorInfo {
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
export function describeCloudflareError(raw: string): CloudflareErrorInfo {
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

export const isAccountScoped = (raw: string | null): boolean =>
	raw != null && describeCloudflareError(raw).scope === "account"

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

/** One renderable zone (poller state joined with warehouse usage). */
export interface ZoneEntry {
	key: string
	name: string
	enabled: boolean
	lastSyncedAt: number | null
	lastError: string | null
	/** null = usage unavailable (loading/failed) — render poller state only. */
	usage: RowUsage | null
}

/**
 * The canonical zone/worker health state. This single derivation feeds the row dot, the detail
 * cell, the summary-chip buckets, and the sort order — so the filter chips can never disagree with
 * what a row actually shows.
 */
export type ZoneStatusKind = "live" | "issue" | "no-data" | "paused" | "disabled"

export interface ZoneStatusInfo {
	kind: ZoneStatusKind
	/** Tailwind bg-* class for the leading status dot. */
	dot: string
	detail: ReactNode
	detailClass: string
}

/** Chip label, dot color, and sort priority per state (live is healthiest → sorts first). */
export const STATUS_META: Record<ZoneStatusKind, { label: string; order: number; dot: string }> = {
	live: { label: "Live", order: 0, dot: "bg-success" },
	issue: { label: "Issues", order: 1, dot: "bg-destructive" },
	"no-data": { label: "No data", order: 2, dot: "bg-warning" },
	paused: { label: "Paused", order: 3, dot: "bg-muted-foreground/40" },
	disabled: { label: "Disabled", order: 4, dot: "bg-muted-foreground/40" },
}

const CHIP_ORDER: ReadonlyArray<ZoneStatusKind> = ["live", "issue", "no-data", "paused", "disabled"]

const rowHasData = (usage: RowUsage | null): boolean =>
	usage != null && (usage.totalRequests > 0 || usage.lastDataAt != null)

/**
 * Resolve one zone/worker to its health state. `usageLoaded` distinguishes "no data yet" (still
 * loading usage) from "no data in the window" (usage settled, zero requests).
 */
export function zoneStatus(entry: ZoneEntry, usageLoaded: boolean): ZoneStatusInfo {
	const { enabled, lastError, usage, lastSyncedAt } = entry
	const err = lastError ? describeCloudflareError(lastError) : null
	const accountPaused = err != null && err.scope === "account"
	const showInlineError = err != null && !accountPaused && err.scope === "resource"

	if (!enabled) {
		return { kind: "disabled", dot: "bg-muted-foreground/40", detail: "Disabled", detailClass: "text-muted-foreground" }
	}
	if (accountPaused) {
		return { kind: "paused", dot: "bg-muted-foreground/40", detail: "Paused", detailClass: "text-muted-foreground" }
	}
	if (showInlineError && err && lastError) {
		const isError = err.tone === "error"
		return {
			kind: "issue",
			dot: isError ? "bg-destructive" : "bg-warning",
			detail: <ErrorLine info={err} raw={lastError} />,
			detailClass: isError ? "text-destructive-foreground" : "text-warning-foreground",
		}
	}
	if (rowHasData(usage)) {
		return {
			kind: "live",
			dot: "bg-success",
			detail: usage?.lastDataAt != null ? `Last data ${relativeFromMs(usage.lastDataAt)}` : "Receiving data",
			detailClass: "text-muted-foreground",
		}
	}
	if (usageLoaded && lastSyncedAt) {
		return { kind: "no-data", dot: "bg-warning", detail: "No data in last 24h", detailClass: "text-warning-foreground" }
	}
	if (lastSyncedAt) {
		return {
			kind: "live",
			dot: "bg-success",
			detail: `Checked ${relativeFromMs(lastSyncedAt)}`,
			detailClass: "text-muted-foreground",
		}
	}
	return { kind: "no-data", dot: "bg-warning", detail: "Waiting for first data", detailClass: "text-warning-foreground" }
}

/**
 * One zone/worker as a single dense line: status dot + name | status detail | 24h sparkline + total.
 * Zones with real traffic link into their `/infra/cloudflare` detail; everything else is a plain row.
 */
function ResourceRow({
	name,
	status,
	usage,
	zoneLink,
}: {
	name: string
	status: ZoneStatusInfo
	usage: RowUsage | null
	/** When set, the row navigates to this zone's edge-analytics detail page. */
	zoneLink?: string
}) {
	const hasData = rowHasData(usage)

	const body = (
		<>
			<span className={cn("mt-[5px] size-1.5 shrink-0 rounded-full", status.dot)} aria-hidden />
			<div className="min-w-0 flex-1">
				<span
					className={cn(
						"block truncate text-xs font-medium text-foreground",
						zoneLink && "group-hover:text-primary",
					)}
					title={name}
				>
					{name}
				</span>
				{/* In a narrow card the status column is hidden, so surface the detail under the name. */}
				<div className={cn("mt-0.5 text-[11px] @lg:hidden", status.detailClass)}>
					{status.detail}
				</div>
			</div>
			<div
				className={cn(
					"hidden w-[190px] min-w-0 shrink-0 self-center text-[11px] @lg:block",
					status.detailClass,
				)}
			>
				{status.detail}
			</div>
			<div className="flex w-[124px] shrink-0 items-center justify-end gap-2.5 self-center">
				{hasData && usage ? (
					<StatSparkline data={usage.points} color={CLOUDFLARE_ACCENT} className="h-5 w-16" />
				) : null}
				<span className="w-12 text-right text-xs font-medium tabular-nums text-foreground">
					{hasData && usage ? formatNumber(usage.totalRequests) : "—"}
				</span>
			</div>
		</>
	)

	const rowClass =
		"group flex items-start gap-3 border-b border-border/40 px-3 py-2 transition-colors last:border-0"

	if (zoneLink) {
		return (
			<Link
				to="/infra/cloudflare/$zoneName"
				params={{ zoneName: zoneLink }}
				className={cn(rowClass, "hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none")}
			>
				{body}
			</Link>
		)
	}
	return <div className={rowClass}>{body}</div>
}

type ZoneSortKey = "name" | "status" | "requests"

/** A zone decorated with its resolved status + traffic total, computed once per render. */
interface DecoratedZone {
	entry: ZoneEntry
	status: ZoneStatusInfo
	requests: number
}

/** One filter chip: state color dot (or none for "All") + label + count. */
function ZoneChip({
	label,
	count,
	dot,
	active,
	onClick,
}: {
	label: string
	count: number
	dot?: string
	active: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={cn(
				"inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors",
				active
					? "bg-muted text-foreground"
					: "border border-border/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground",
			)}
		>
			{dot ? <span aria-hidden className={cn("size-1.5 rounded-full", dot)} /> : null}
			{label}
			<span className={cn("tabular-nums", active ? "text-muted-foreground" : "text-muted-foreground/70")}>
				{count}
			</span>
		</button>
	)
}

/**
 * The Cloudflare zone health board: a status rollup that doubles as filter chips, a name search, and
 * a sortable, bounded, internally-scrolling table. Replaces the old flat unbounded status-row list so
 * an account with a hundred+ zones stays scannable.
 */
export function CloudflareZoneBoard({
	zones,
	usageLoaded,
	banner,
	className,
}: {
	zones: ReadonlyArray<ZoneEntry>
	usageLoaded: boolean
	/** Account-scope problem banner (missing scopes, revoked token) rendered inside the card. */
	banner?: ReactNode
	className?: string
}) {
	const [search, setSearch] = useState("")
	const [filter, setFilter] = useState<ZoneStatusKind | "all">("all")
	const [sortKey, setSortKey] = useState<ZoneSortKey>("requests")
	const [sortDir, setSortDir] = useState<SortDir>("desc")

	const decorated = useMemo<Array<DecoratedZone>>(
		() =>
			zones.map((entry) => ({
				entry,
				status: zoneStatus(entry, usageLoaded),
				requests: entry.usage?.totalRequests ?? 0,
			})),
		[zones, usageLoaded],
	)

	const counts = useMemo(() => {
		const tally: Record<ZoneStatusKind, number> = { live: 0, issue: 0, "no-data": 0, paused: 0, disabled: 0 }
		for (const zone of decorated) tally[zone.status.kind] += 1
		return tally
	}, [decorated])

	const query = search.trim().toLowerCase()
	const filtered = useMemo(
		() =>
			decorated.filter(
				(zone) =>
					(filter === "all" || zone.status.kind === filter) &&
					(query === "" || zone.entry.name.toLowerCase().includes(query)),
			),
		[decorated, filter, query],
	)

	const sorted = useMemo(() => {
		const copy = [...filtered]
		copy.sort((a, b) => {
			let primary =
				sortKey === "name"
					? a.entry.name.localeCompare(b.entry.name)
					: sortKey === "requests"
						? a.requests - b.requests
						: STATUS_META[a.status.kind].order - STATUS_META[b.status.kind].order
			primary = sortDir === "asc" ? primary : -primary
			// Stable tiebreak: busiest first, regardless of the active direction.
			return primary !== 0 ? primary : b.requests - a.requests
		})
		return copy
	}, [filtered, sortKey, sortDir])

	const handleSort = (key: ZoneSortKey) => {
		if (key === sortKey) {
			setSortDir((dir) => (dir === "asc" ? "desc" : "asc"))
		} else {
			setSortKey(key)
			// Names/status read best low-to-high; traffic reads best high-to-low.
			setSortDir(key === "requests" ? "desc" : "asc")
		}
	}

	const activeChip = (kind: ZoneStatusKind | "all") => () =>
		setFilter((current) => (current === kind ? "all" : kind))

	return (
		<div
			className={cn(
				"@container flex flex-col overflow-hidden rounded-lg border border-border/60 bg-card",
				className,
			)}
		>
			{/* Title bar: the health rollup (chips double as a single-select filter) + a name search. */}
			<div className="flex flex-wrap items-center gap-2 border-b border-border/60 py-2.5 pl-4 pr-2.5">
				<h3 className="text-sm font-semibold">Zones</h3>
				<div
					role="tablist"
					aria-label="Filter zones by status"
					className="ml-auto flex flex-wrap items-center gap-1.5"
				>
					<ZoneChip label="All" count={decorated.length} active={filter === "all"} onClick={activeChip("all")} />
					{CHIP_ORDER.filter((kind) => counts[kind] > 0).map((kind) => (
						<ZoneChip
							key={kind}
							label={STATUS_META[kind].label}
							count={counts[kind]}
							dot={STATUS_META[kind].dot}
							active={filter === kind}
							onClick={activeChip(kind)}
						/>
					))}
				</div>
				<InputGroup className="w-full sm:w-[170px]">
					<InputGroupAddon>
						<MagnifierIcon />
					</InputGroupAddon>
					<InputGroupInput
						size="sm"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Filter zones…"
						aria-label="Filter zones by name"
					/>
					{search ? (
						<InputGroupAddon align="inline-end">
							<InputGroupButton aria-label="Clear filter" onClick={() => setSearch("")}>
								<XmarkIcon />
							</InputGroupButton>
						</InputGroupAddon>
					) : null}
				</InputGroup>
			</div>

			{banner ? <div className="px-3 pt-3">{banner}</div> : null}
			<div className="flex flex-col">

				{/* Sortable column header — aligns with the row's leading status-dot via an invisible spacer. */}
				<div className="flex items-center gap-3 border-b border-border/60 px-3 py-2">
					<span aria-hidden className="size-1.5 shrink-0" />
					<ColumnHead<ZoneSortKey>
						label="Zone"
						sortKey="name"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						width="min-w-0 flex-1"
					/>
					<ColumnHead<ZoneSortKey>
						label="Status"
						sortKey="status"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						width="w-[190px]"
						hidden="hidden @lg:flex"
					/>
					<ColumnHead<ZoneSortKey>
						label="24h requests"
						sortKey="requests"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[124px]"
					/>
				</div>

				{sorted.length === 0 ? (
					<div className="px-3 py-10 text-center text-[12px] text-muted-foreground">
						{query
							? `No zones match "${search.trim()}".`
							: "No zones in this state."}
					</div>
				) : (
					// Plain max-height + overflow container (not the Base UI ScrollArea, whose `h-full`
					// viewport needs a definite-height ancestor — with only a max-height it clips without
					// scrolling). This grows with content up to the cap, then scrolls internally.
					<div className="max-h-[22rem] overflow-y-auto overscroll-contain">
						{sorted.map((zone) => (
							<ResourceRow
								key={zone.entry.key}
								name={zone.entry.name}
								status={zone.status}
								usage={zone.entry.usage}
								zoneLink={zone.requests > 0 ? zone.entry.name : undefined}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	)
}

const WORKERS_COLLAPSED_COUNT = 6

/**
 * The Workers side panel: per-script 24h invocation counts as a compact list,
 * linking out to the service map where the scripts live as nodes. Collapsed to
 * the busiest scripts; the aggregate health detail surfaces only when Workers
 * collection has a problem (rows carry the healthy signal on their own).
 */
export function CloudflareWorkersCard({
	workerEntry,
	workerServices,
	usageLoaded,
	className,
}: {
	/** Aggregate Workers state in the zone-entry shape (drives the problem line). */
	workerEntry: ZoneEntry
	workerServices: ReadonlyArray<CloudflareServiceUsage>
	usageLoaded: boolean
	className?: string
}) {
	const [expanded, setExpanded] = useState(false)
	const aggregate = zoneStatus(workerEntry, usageLoaded)
	const scripts = useMemo(
		() => [...workerServices].sort((a, b) => b.totalRequests - a.totalRequests),
		[workerServices],
	)
	const visible = expanded ? scripts : scripts.slice(0, WORKERS_COLLAPSED_COUNT)

	return (
		<div
			className={cn(
				"flex h-fit flex-col overflow-hidden rounded-lg border border-border/60 bg-card",
				className,
			)}
		>
			<div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
				<h3 className="text-sm font-semibold">Workers</h3>
				<Link
					to="/service-map"
					className="text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					View on map →
				</Link>
			</div>

			{aggregate.kind === "issue" || aggregate.kind === "no-data" ? (
				<div className={cn("border-b border-border/40 px-4 py-2 text-[11px]", aggregate.detailClass)}>
					{aggregate.detail}
				</div>
			) : null}

			{scripts.length === 0 ? (
				<div className="flex items-center gap-2.5 px-4 py-3">
					<span className={cn("size-1.5 shrink-0 rounded-full", aggregate.dot)} aria-hidden />
					<span className={cn("text-[11px]", aggregate.detailClass)}>{aggregate.detail}</span>
				</div>
			) : (
				<div className="flex flex-col px-4 pb-2 pt-1">
					{visible.map((service) => (
						<div
							key={service.serviceName}
							className="flex items-center justify-between gap-3 border-b border-border/40 py-2.5 last:border-0"
						>
							<span className="flex min-w-0 items-center gap-2.5">
								<span
									className={cn(
										"size-1.5 shrink-0 rounded-full",
										service.totalRequests > 0 ? "bg-success" : "bg-muted-foreground/40",
									)}
									aria-hidden
								/>
								<span
									className="truncate text-xs font-medium text-foreground"
									title={service.displayName}
								>
									{service.displayName}
								</span>
							</span>
							<span className="shrink-0 text-xs font-medium tabular-nums text-foreground">
								{service.totalRequests > 0 ? formatNumber(service.totalRequests) : "—"}
							</span>
						</div>
					))}
					{scripts.length > WORKERS_COLLAPSED_COUNT ? (
						<button
							type="button"
							onClick={() => setExpanded((current) => !current)}
							className="pb-1 pt-2.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
						>
							{expanded
								? "Show fewer"
								: `Showing ${visible.length} of ${scripts.length} · View all →`}
						</button>
					) : null}
				</div>
			)}
		</div>
	)
}
