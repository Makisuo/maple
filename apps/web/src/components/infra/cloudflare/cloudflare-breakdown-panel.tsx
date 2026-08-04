// One panel, every dimension.
//
// Replaces the standalone Hosts section and Top-traffic card: a dimension
// switcher over a stacked timeseries plus a ranked table, where clicking a row
// name filters the whole page by it. Adding a dimension is a poller metric and
// a registry row — not another card on an already-long page.
//
// Three things it refuses to fake:
//   - Coverage. The stored breakdown is a per-window top-N fold, so the footer
//     states what share of zone traffic the listed keys actually account for,
//     and when collection for this dimension started. A window that predates
//     the dataset reads "not collected", never "no traffic".
//   - The long tail. The toolbar filter narrows the keys already on screen;
//     when that isn't enough, "Search all …" runs a live Cloudflare query that
//     can see paths the stored top-N never kept. The chart hides there, because
//     live mode has no history. Live is an action, never a side effect of
//     typing — every keystroke used to be a Cloudflare GraphQL round trip.
//   - Rank. Rows carry a share-proportional tint, so a hundred keys read as a
//     decaying shape instead of a flat wall of names.

import { useDeferredValue, useMemo, useState, type ReactNode } from "react"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { Result, useAtomValue } from "@/lib/effect-atom"
import type {
	CloudflareBreakdownDimension,
	CloudflareBreakdownTotal,
	CloudflareZoneBreakdown,
} from "@/api/warehouse/cloudflare-infra"
import {
	cloudflareTopTrafficResultAtom,
	cloudflareZoneBreakdownResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { formatNumber } from "@maple/ui/lib/format"
import { MagnifierIcon, XmarkIcon } from "@/components/icons"
import { ColumnHead, DataTable, useTableSort } from "../primitives/data-table"
import { shareTint } from "../primitives/share-tint"
import { formatBytes, formatPercent } from "@maple/ui/lib/format"
import { StackedBreakdownChart } from "./cloudflare-zone-detail-charts"
import {
	CACHE_STATUS_COLORS,
	CACHE_STATUS_ORDER,
	errorRateClass,
	STATUS_CLASS_COLORS,
	STATUS_CLASS_ORDER,
} from "./constants"
import { PanelScope } from "./panel-scope"
import type { CloudflareFilterKey, CloudflareFilters } from "./filters"

const warehouseTimeToMs = (value: string) => new Date(value.replace(" ", "T") + "Z").getTime()

/** Rows the server returns per dimension. The table scrolls rather than growing the page. */
const ROW_LIMIT = 100
const TABLE_MAX_HEIGHT = 420

interface DimensionDef {
	readonly id: CloudflareBreakdownDimension
	/** Switcher label. */
	readonly tab: string
	/** Column heading for the key column. */
	readonly column: string
	/** Plural noun for the filter placeholder and the live-search action. */
	readonly noun: string
	/** Which page filter a row click toggles. */
	readonly filterKey: CloudflareFilterKey
	readonly colors?: Record<string, string>
	readonly order?: ReadonlyArray<string>
	/** Live Cloudflare search is only wired for the dimensions the proxy exposes. */
	readonly liveDimension?: "host" | "path"
}

const DIMENSIONS: ReadonlyArray<DimensionDef> = [
	{
		id: "path",
		tab: "Paths",
		column: "Path",
		noun: "paths",
		filterKey: "paths",
		liveDimension: "path",
	},
	{
		id: "host",
		tab: "Hosts",
		column: "Host",
		noun: "hosts",
		filterKey: "hosts",
		liveDimension: "host",
	},
	{ id: "country", tab: "Countries", column: "Country", noun: "countries", filterKey: "countries" },
	{ id: "method", tab: "Methods", column: "Method", noun: "methods", filterKey: "methods" },
	{
		id: "statusClass",
		tab: "Status",
		column: "Status class",
		noun: "status classes",
		filterKey: "statusClasses",
		colors: STATUS_CLASS_COLORS,
		order: STATUS_CLASS_ORDER,
	},
	{
		id: "cacheStatus",
		tab: "Cache",
		column: "Cache status",
		noun: "cache statuses",
		filterKey: "cacheStatuses",
		colors: CACHE_STATUS_COLORS,
		order: CACHE_STATUS_ORDER,
	},
]

const ROW_CLASS =
	"flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0 hover:bg-muted/40"

const CHIP_CLASS =
	"inline-flex items-center rounded-sm border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"

/** ISO-8601 UTC → "Jul 28". */
const formatCollectedFrom = (iso: string) => {
	const date = new Date(iso)
	return Number.isNaN(date.getTime())
		? null
		: date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
}

export function CloudflareBreakdownPanel({
	serviceName,
	zoneName,
	startTime,
	endTime,
	bucketSeconds,
	filters,
	onToggleFilter,
	syncId,
}: {
	serviceName: string
	zoneName: string
	/** Warehouse datetime strings (`YYYY-MM-DD HH:mm:ss`), same as the sibling sections. */
	startTime: string
	endTime: string
	bucketSeconds: number
	filters: CloudflareFilters
	onToggleFilter: (key: CloudflareFilterKey, value: string) => void
	syncId?: string
}) {
	const [dimensionId, setDimensionId] = useState<CloudflareBreakdownDimension>("path")
	const [search, setSearch] = useState("")
	// Set only by the explicit "Search all …" action. Typing clears it, so the panel falls straight
	// back to the stored rows instead of holding a stale Cloudflare result on screen.
	const [liveQuery, setLiveQuery] = useState<string | null>(null)
	const dimension = DIMENSIONS.find((d) => d.id === dimensionId) ?? DIMENSIONS[0]!
	const live = liveQuery !== null

	// Read here rather than inside StoredBreakdown so the header's scope marker can report the
	// filters the server actually applied instead of guessing at them.
	const storedResult = useRetainedRefreshableResultValue(
		cloudflareZoneBreakdownResultAtom({
			data: {
				serviceName,
				dimension: dimension.id,
				startTime,
				endTime,
				bucketSeconds,
				limit: ROW_LIMIT,
				...filters,
			},
		}),
	)
	const ignoredFilters = Result.builder(storedResult)
		.onSuccess((data) => data.ignoredFilters)
		.orElse(() => undefined)

	const selectDimension = (id: CloudflareBreakdownDimension) => {
		setDimensionId(id)
		setSearch("")
		setLiveQuery(null)
	}

	const onSearchChange = (value: string) => {
		setSearch(value)
		setLiveQuery(null)
	}

	return (
		<div className="rounded-md border bg-card">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 pt-2.5 pb-2">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-[11px] font-medium text-muted-foreground">Breakdown</span>
					{live ? (
						<button
							type="button"
							onClick={() => setLiveQuery(null)}
							className={cn(CHIP_CLASS, "gap-1 transition-colors hover:text-foreground")}
						>
							live
							<XmarkIcon size={9} />
						</button>
					) : (
						<PanelScope
							filters={filters}
							ignoredFilters={ignoredFilters}
							reason={`This breakdown is grouped by ${dimension.column.toLowerCase()}`}
						/>
					)}
				</div>
				<div className="flex items-center gap-1" role="tablist" aria-label="Breakdown dimension">
					{DIMENSIONS.map((d) => (
						<button
							key={d.id}
							type="button"
							role="tab"
							aria-selected={d.id === dimensionId}
							onClick={() => selectDimension(d.id)}
							className={cn(
								"rounded px-2 py-0.5 text-[11px] transition-colors",
								d.id === dimensionId
									? "bg-muted font-medium text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{d.tab}
						</button>
					))}
				</div>
			</div>

			{live ? (
				<LiveBreakdown
					zoneName={zoneName}
					dimension={dimension}
					query={liveQuery}
					startTime={startTime}
					endTime={endTime}
					search={search}
					onSearchChange={onSearchChange}
				/>
			) : (
				<StoredBreakdown
					result={storedResult}
					dimension={dimension}
					startTime={startTime}
					filters={filters}
					onToggleFilter={onToggleFilter}
					syncId={syncId}
					search={search}
					onSearchChange={onSearchChange}
					onSearchLive={() => setLiveQuery(search.trim())}
				/>
			)}
		</div>
	)
}

/**
 * Narrows the keys already on screen. Nothing here touches the network — the whole point of moving
 * the live lookup behind a button is that typing stays free.
 */
function Toolbar({
	dimension,
	value,
	onChange,
	count,
	meta,
}: {
	dimension: DimensionDef
	value: string
	onChange: (value: string) => void
	/** Rows available to filter, for the placeholder. */
	count: number
	meta?: ReactNode
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 pb-2">
			<label className="flex h-6 min-w-0 max-w-xs flex-1 items-center gap-1.5 rounded-sm border border-border/70 bg-background/60 px-2 transition-colors focus-within:border-ring">
				<MagnifierIcon size={11} className="shrink-0 text-muted-foreground" />
				<input
					type="search"
					value={value}
					onChange={(event) => onChange(event.target.value)}
					placeholder={`Filter ${count} ${dimension.noun}`}
					aria-label={`Filter the listed ${dimension.noun}`}
					className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
				/>
				{value ? (
					<button
						type="button"
						onClick={() => onChange("")}
						aria-label="Clear filter"
						className="shrink-0 rounded-xs p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
					>
						<XmarkIcon size={9} />
					</button>
				) : null}
			</label>
			{meta}
		</div>
	)
}

type SortKey = "key" | "requests" | "errorRate" | "bytes"

function BreakdownTable({
	dimension,
	rows,
	waiting,
	emptyMessage,
	filters,
	onToggleFilter,
	interactive,
}: {
	dimension: DimensionDef
	rows: ReadonlyArray<CloudflareBreakdownTotal>
	waiting?: boolean
	emptyMessage: string
	filters?: CloudflareFilters
	onToggleFilter?: (key: CloudflareFilterKey, value: string) => void
	/** Live rows are not page filters — Cloudflare ranked them, the warehouse has no slice for them. */
	interactive: boolean
}) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<CloudflareBreakdownTotal, SortKey>(rows, {
		initialKey: "requests",
		stringKeys: ["key"],
	})
	const selectedValues = filters?.[dimension.filterKey] ?? []

	const head = (label: string, key: SortKey, className: string, hidden?: string) => (
		<ColumnHead<SortKey>
			label={label}
			sortKey={key}
			currentKey={sortKey}
			dir={sortDir}
			onSort={handleSort}
			align={key === "key" ? "left" : "right"}
			width={className}
			hidden={hidden}
		/>
	)

	return (
		<DataTable.Root
			ariaLabel={`${dimension.column} breakdown`}
			waiting={waiting}
			maxHeight={TABLE_MAX_HEIGHT}
			stickySurfaceClass="bg-card"
		>
			<DataTable.Head>
				{head(dimension.column, "key", "flex-1 min-w-[220px]")}
				{head("Requests", "requests", "w-[110px]")}
				{head("Error rate", "errorRate", "w-[90px]")}
				{head("Bandwidth", "bytes", "w-[90px]", "hidden md:flex")}
			</DataTable.Head>
			{sorted.length === 0 && <DataTable.Empty>{emptyMessage}</DataTable.Empty>}

			{sorted.map((row) => {
				const selected = selectedValues.includes(row.key)
				return (
					<div
						key={row.key}
						className={ROW_CLASS}
						style={{ backgroundImage: shareTint(row.share) }}
					>
						<div className="min-w-[220px] flex-1 truncate">
							{interactive && onToggleFilter ? (
								<button
									type="button"
									onClick={() => onToggleFilter(dimension.filterKey, row.key)}
									aria-pressed={selected}
									title={`Filter this page by ${row.key || "—"}`}
									className={cn(
										"max-w-full truncate rounded-xs font-mono text-[13px] underline-offset-2 hover:underline focus-visible:outline-1 focus-visible:outline-ring",
										selected ? "text-primary" : "text-foreground",
									)}
								>
									{row.key || "—"}
								</button>
							) : (
								<span className="block max-w-full truncate font-mono text-[13px] text-foreground">
									{row.key || "—"}
								</span>
							)}
						</div>
						<div
							className="w-[110px] text-right font-mono text-[12px] tabular-nums text-foreground/80"
							title={`${formatPercent(row.share)} of listed requests`}
						>
							{formatNumber(row.requests)}
						</div>
						<div
							className={cn(
								"w-[90px] text-right font-mono text-[12px] tabular-nums",
								errorRateClass(row.errorRate),
							)}
						>
							{formatPercent(row.errorRate)}
						</div>
						<div className="hidden w-[90px] text-right font-mono text-[12px] tabular-nums text-foreground/80 md:block">
							{formatBytes(row.bytes)}
						</div>
					</div>
				)
			})}
		</DataTable.Root>
	)
}

function StoredBreakdown({
	result,
	dimension,
	startTime,
	filters,
	onToggleFilter,
	syncId,
	search,
	onSearchChange,
	onSearchLive,
}: {
	result: Result.Result<CloudflareZoneBreakdown, unknown>
	dimension: DimensionDef
	/** Window start, for deciding whether collection began mid-window. */
	startTime: string
	filters: CloudflareFilters
	onToggleFilter: (key: CloudflareFilterKey, value: string) => void
	syncId?: string
	search: string
	onSearchChange: (value: string) => void
	onSearchLive: () => void
}) {
	// Deferred so a keystroke paints the input immediately and the 100-row re-render trails it.
	const query = useDeferredValue(search).trim().toLowerCase()

	return Result.builder(result)
		.onInitial(() => (
			<div className="space-y-2 px-3 pb-3">
				<Skeleton className="h-40 w-full" />
				<Skeleton className="h-4 w-5/6" />
				<Skeleton className="h-4 w-2/3" />
			</div>
		))
		.onError(() => (
			<p className="px-3 pb-3 font-mono text-[11px] text-muted-foreground">
				Couldn't load the {dimension.column.toLowerCase()} breakdown.
			</p>
		))
		.onSuccess((data, r) => {
			const collectedFrom =
				data.coverageStart != null &&
				warehouseTimeToMs(startTime) < new Date(data.coverageStart).getTime() - 60_000
					? formatCollectedFrom(data.coverageStart)
					: null
			const notCollected = data.coverageStart == null && data.totals.length === 0
			const matches =
				query === ""
					? data.totals
					: data.totals.filter((row) => row.key.toLowerCase().includes(query))

			return (
				<div className={cn("transition-opacity", r.waiting && "opacity-60")}>
					<Toolbar
						dimension={dimension}
						value={search}
						onChange={onSearchChange}
						count={data.totals.length}
						meta={
							// Below 99.5% the fold is actually hiding something; above it, saying so is noise.
							data.coverage < 0.995 && data.totals.length > 0 ? (
								<span className="font-mono text-[10px] text-muted-foreground">
									{formatPercent(data.coverage)} of zone requests
								</span>
							) : null
						}
					/>
					<div className="px-3 pb-2">
						<StackedBreakdownChart
							title={dimension.column}
							rows={data.buckets.map((b) => ({
								bucket: b.bucket,
								attributeValue: b.key,
								value: b.requests,
							}))}
							colors={dimension.colors ?? {}}
							order={dimension.order ?? []}
							syncId={syncId}
						/>
					</div>
					<BreakdownTable
						dimension={dimension}
						rows={matches}
						waiting={r.waiting}
						emptyMessage={
							query !== ""
								? `No listed ${dimension.noun} match "${search.trim()}".`
								: notCollected
									? `Not collected for this period. ${dimension.column} data starts once the poller has run.`
									: "No traffic in the selected window."
						}
						filters={filters}
						onToggleFilter={onToggleFilter}
						interactive
					/>
					<Footer
						dimension={dimension}
						shown={matches.length}
						total={data.totals.length}
						collectedFrom={collectedFrom}
						onSearchLive={
							dimension.liveDimension !== undefined && search.trim() !== ""
								? onSearchLive
								: undefined
						}
					/>
				</div>
			)
		})
		.render()
}

function Footer({
	dimension,
	shown,
	total,
	collectedFrom,
	onSearchLive,
}: {
	dimension: DimensionDef
	shown: number
	total: number
	collectedFrom: string | null
	/** Present only when a live lookup could add something the stored top-N never kept. */
	onSearchLive?: () => void
}) {
	if (total === 0 && onSearchLive === undefined) return null
	const parts = [
		shown === total ? `${total} ${dimension.noun}` : `Showing ${shown} of ${total} ${dimension.noun}`,
		collectedFrom ? `collected from ${collectedFrom}` : null,
	].filter((part): part is string => part !== null)

	return (
		<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
			<p className="font-mono text-[10px] text-muted-foreground">{parts.join(" · ")}</p>
			{onSearchLive ? (
				<button
					type="button"
					onClick={onSearchLive}
					className="font-mono text-[10px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
				>
					Search all {dimension.noun} in Cloudflare
				</button>
			) : null}
		</div>
	)
}

/**
 * Live Cloudflare lookup for the long tail the stored top-N never kept. No history — Cloudflare
 * ranks the window as a whole — so this renders the table only.
 */
function LiveBreakdown({
	zoneName,
	dimension,
	query,
	startTime,
	endTime,
	search,
	onSearchChange,
}: {
	zoneName: string
	dimension: DimensionDef
	query: string
	startTime: string
	endTime: string
	search: string
	onSearchChange: (value: string) => void
}) {
	const { startMs, endMs } = useMemo(
		() => ({ startMs: warehouseTimeToMs(startTime), endMs: warehouseTimeToMs(endTime) }),
		[startTime, endTime],
	)
	const result = useAtomValue(
		cloudflareTopTrafficResultAtom({
			data: {
				zoneName,
				dimension: dimension.liveDimension ?? "path",
				startTime: startMs,
				endTime: endMs,
				limit: 50,
				contains: query,
			},
		}),
	)

	const toolbar = (count: number) => (
		<Toolbar
			dimension={dimension}
			value={search}
			onChange={onSearchChange}
			count={count}
			meta={
				<span className="font-mono text-[10px] text-muted-foreground">
					Live from Cloudflare · no history
				</span>
			}
		/>
	)

	return Result.builder(result)
		.onInitial(() => (
			<>
				{toolbar(0)}
				<div className="space-y-2 px-3 pb-3">
					<Skeleton className="h-4 w-full" />
					<Skeleton className="h-4 w-5/6" />
					<Skeleton className="h-4 w-2/3" />
				</div>
			</>
		))
		.onError(() => (
			<>
				{toolbar(0)}
				<p className="px-3 pb-3 font-mono text-[11px] text-muted-foreground">
					Couldn't reach Cloudflare's analytics API for this zone right now.
				</p>
			</>
		))
		.onSuccess((data, r) => {
			if (data.unavailableReason != null) {
				return (
					<>
						{toolbar(0)}
						<p className="px-3 pb-3 font-mono text-[11px] text-muted-foreground">
							Cloudflare can't serve this breakdown: {data.unavailableReason}
						</p>
					</>
				)
			}
			const attributed = data.rows.reduce((sum, row) => sum + row.requests, 0)
			const rows = data.rows.map(
				(row): CloudflareBreakdownTotal => ({
					key: row.key,
					requests: row.requests,
					errors5xx: 0,
					bytes: row.bytes,
					errorRate: row.errorRate,
					share: attributed > 0 ? row.requests / attributed : 0,
				}),
			)

			return (
				<div className={cn("transition-opacity", r.waiting && "opacity-60")}>
					{toolbar(rows.length)}
					<BreakdownTable
						dimension={dimension}
						rows={rows}
						waiting={r.waiting}
						emptyMessage={`No ${dimension.noun} match "${query}" in this window.`}
						interactive={false}
					/>
					<p className="px-3 py-2 font-mono text-[10px] text-muted-foreground">
						Cloudflare's top {rows.length} for "{query}" · clear the filter to return to stored
						data
					</p>
				</div>
			)
		})
		.render()
}
