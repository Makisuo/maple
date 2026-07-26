// One panel, every dimension.
//
// Replaces the standalone Hosts section and Top-traffic card: a dimension
// switcher over a stacked timeseries plus a ranked table, where clicking a row
// name filters the whole page by it. Adding a dimension is a poller metric and
// a registry row — not another card on an already-long page.
//
// Two things it refuses to fake:
//   - Coverage. The stored breakdown is a per-window top-N fold, so the footer
//     states what share of zone traffic the listed keys actually account for,
//     and when collection for this dimension started. A window that predates
//     the dataset reads "not collected", never "no traffic".
//   - The long tail. Typing in the search box switches the panel to a live
//     Cloudflare query, which can see paths the stored top-N never kept. The
//     chart greys out there, because live mode has no history.

import { useMemo, useState } from "react"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { Result, useAtomValue } from "@/lib/effect-atom"
import type {
	CloudflareBreakdownDimension,
	CloudflareZoneBreakdown,
} from "@/api/warehouse/cloudflare-infra"
import {
	cloudflareTopTrafficResultAtom,
	cloudflareZoneBreakdownResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import { formatNumber } from "@/lib/format"
import { MagnifierIcon, XmarkIcon } from "@/components/icons"
import { ColumnHead, TableShell } from "../primitives/data-table"
import { formatPercent } from "../format"
import { StackedBreakdownChart } from "./cloudflare-zone-detail-charts"
import {
	CACHE_STATUS_COLORS,
	CACHE_STATUS_ORDER,
	errorRateClass,
	STATUS_CLASS_COLORS,
	STATUS_CLASS_ORDER,
} from "./constants"
import { formatBytes } from "./format"
import { PanelScope } from "./panel-scope"
import type { CloudflareFilterKey, CloudflareFilters } from "./filters"

const warehouseTimeToMs = (value: string) => new Date(value.replace(" ", "T") + "Z").getTime()

interface DimensionDef {
	readonly id: CloudflareBreakdownDimension
	/** Switcher label. */
	readonly tab: string
	/** Column heading for the key column. */
	readonly column: string
	/** Which page filter a row click toggles. */
	readonly filterKey: CloudflareFilterKey
	readonly colors?: Record<string, string>
	readonly order?: ReadonlyArray<string>
	/** Live Cloudflare search is only wired for the dimensions the proxy exposes. */
	readonly liveDimension?: "host" | "path"
}

const DIMENSIONS: ReadonlyArray<DimensionDef> = [
	{ id: "path", tab: "Paths", column: "Path", filterKey: "paths", liveDimension: "path" },
	{ id: "host", tab: "Hosts", column: "Host", filterKey: "hosts", liveDimension: "host" },
	{ id: "country", tab: "Countries", column: "Country", filterKey: "countries" },
	{ id: "method", tab: "Methods", column: "Method", filterKey: "methods" },
	{
		id: "statusClass",
		tab: "Status",
		column: "Status class",
		filterKey: "statusClasses",
		colors: STATUS_CLASS_COLORS,
		order: STATUS_CLASS_ORDER,
	},
	{
		id: "cacheStatus",
		tab: "Cache",
		column: "Cache status",
		filterKey: "cacheStatuses",
		colors: CACHE_STATUS_COLORS,
		order: CACHE_STATUS_ORDER,
	},
]

const ROW_CLASS =
	"flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0 hover:bg-muted/40"

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
	const dimension = DIMENSIONS.find((d) => d.id === dimensionId) ?? DIMENSIONS[0]!
	// Live mode only exists for the dimensions Cloudflare's proxy can rank on demand.
	const live = search.trim() !== "" && dimension.liveDimension !== undefined

	// Read here rather than inside StoredBreakdown so the header's scope marker can report the
	// filters the server actually applied instead of guessing at them.
	const storedResult = useAtomValue(
		cloudflareZoneBreakdownResultAtom({
			data: {
				serviceName,
				dimension: dimension.id,
				startTime,
				endTime,
				bucketSeconds,
				limit: 100,
				...filters,
			},
		}),
	)
	const ignoredFilters = Result.builder(storedResult)
		.onSuccess((data) => data.ignoredFilters)
		.orElse(() => undefined)

	return (
		<div className="rounded-md border bg-card">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 pt-2.5 pb-2">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-[11px] font-medium text-muted-foreground">Breakdown</span>
					{live ? (
						<span className="inline-flex items-center rounded-sm border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
							live
						</span>
					) : (
						<PanelScope
							filters={filters}
							ignoredFilters={ignoredFilters}
							reason={`This breakdown is grouped by ${dimension.column.toLowerCase()}`}
						/>
					)}
				</div>
				<div
					className="flex items-center gap-1"
					role="tablist"
					aria-label="Breakdown dimension"
				>
					{DIMENSIONS.map((d) => (
						<button
							key={d.id}
							type="button"
							role="tab"
							aria-selected={d.id === dimensionId}
							onClick={() => {
								setDimensionId(d.id)
								setSearch("")
							}}
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
					query={search.trim()}
					startTime={startTime}
					endTime={endTime}
				/>
			) : (
				<StoredBreakdown
					result={storedResult}
					dimension={dimension}
					startTime={startTime}
					filters={filters}
					onToggleFilter={onToggleFilter}
					syncId={syncId}
				/>
			)}

			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2">
				<SearchBox
					dimension={dimension}
					value={search}
					onChange={setSearch}
					live={live}
				/>
			</div>
		</div>
	)
}

function SearchBox({
	dimension,
	value,
	onChange,
	live,
}: {
	dimension: DimensionDef
	value: string
	onChange: (value: string) => void
	live: boolean
}) {
	if (dimension.liveDimension === undefined) return <span />
	return (
		<label className="flex min-w-0 flex-1 items-center gap-1.5">
			<MagnifierIcon size={11} className="shrink-0 text-muted-foreground" />
			<input
				type="search"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder={`Search all ${dimension.tab.toLowerCase()} live`}
				aria-label={`Search all ${dimension.tab.toLowerCase()} in Cloudflare`}
				className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
			/>
			{live ? (
				<button
					type="button"
					onClick={() => onChange("")}
					className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
				>
					live
					<XmarkIcon size={9} />
				</button>
			) : null}
		</label>
	)
}

function StoredBreakdown({
	result,
	dimension,
	startTime,
	filters,
	onToggleFilter,
	syncId,
}: {
	result: Result.Result<CloudflareZoneBreakdown, unknown>
	dimension: DimensionDef
	/** Window start, for deciding whether collection began mid-window. */
	startTime: string
	filters: CloudflareFilters
	onToggleFilter: (key: CloudflareFilterKey, value: string) => void
	syncId?: string
}) {
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

			return (
				<div className={cn("transition-opacity", r.waiting && "opacity-60")}>
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
					<TableShell
						ariaLabel={`${dimension.column} breakdown`}
						waiting={r.waiting}
						isEmpty={data.totals.length === 0}
						emptyMessage={
							notCollected
								? `Not collected for this period. ${dimension.column} data starts once the poller has run.`
								: "No traffic in the selected window."
						}
						header={
							<>
								<ColumnHead label={dimension.column} width="flex-1 min-w-[220px]" />
								<ColumnHead label="Requests" align="right" width="w-[110px]" />
								<ColumnHead label="Error rate" align="right" width="w-[90px]" />
								<ColumnHead
									label="Bandwidth"
									align="right"
									width="w-[90px]"
									hidden="hidden md:flex"
								/>
							</>
						}
					>
						{data.totals.map((row) => {
							const selected = (filters[dimension.filterKey] ?? []).includes(row.key)
							return (
								<div key={row.key} className={ROW_CLASS}>
									<div className="min-w-[220px] flex-1 truncate">
										<button
											type="button"
											onClick={() => onToggleFilter(dimension.filterKey, row.key)}
											aria-pressed={selected}
											className={cn(
												"max-w-full truncate rounded-xs font-mono text-[13px] underline-offset-2 hover:underline focus-visible:outline-1 focus-visible:outline-ring",
												selected ? "text-primary" : "text-foreground",
											)}
										>
											{row.key || "—"}
										</button>
									</div>
									<div className="w-[110px]">
										<div className="flex items-center justify-end gap-2">
											<ShareBar share={row.share} />
											<span className="font-mono text-[12px] tabular-nums text-foreground/80">
												{formatNumber(row.requests)}
											</span>
										</div>
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
					</TableShell>
					<Coverage
						dimension={dimension}
						count={data.totals.length}
						coverage={data.coverage}
						collectedFrom={collectedFrom}
					/>
				</div>
			)
		})
		.render()
}

function Coverage({
	dimension,
	count,
	coverage,
	collectedFrom,
}: {
	dimension: DimensionDef
	count: number
	coverage: number
	collectedFrom: string | null
}) {
	if (count === 0) return null
	const parts = [
		`Top ${count} ${dimension.tab.toLowerCase()}`,
		// Below 99.5% the fold is actually hiding something; above it, saying so is noise.
		coverage < 0.995 ? `${formatPercent(coverage)} of requests` : null,
		collectedFrom ? `collected from ${collectedFrom}` : null,
	].filter((part): part is string => part !== null)
	return (
		<p className="px-3 pt-2 font-mono text-[10px] text-muted-foreground">{parts.join(" · ")}</p>
	)
}

function ShareBar({ share }: { share: number }) {
	return (
		<span
			aria-hidden
			className="hidden h-1 w-10 overflow-hidden rounded-full bg-muted sm:block"
			title={formatPercent(share)}
		>
			<span
				className="block h-full rounded-full bg-primary/60"
				style={{ width: `${Math.min(100, Math.max(2, share * 100))}%` }}
			/>
		</span>
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
}: {
	zoneName: string
	dimension: DimensionDef
	query: string
	startTime: string
	endTime: string
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

	return Result.builder(result)
		.onInitial(() => (
			<div className="space-y-2 px-3 pb-3">
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-4 w-5/6" />
				<Skeleton className="h-4 w-2/3" />
			</div>
		))
		.onError(() => (
			<p className="px-3 pb-3 font-mono text-[11px] text-muted-foreground">
				Couldn't reach Cloudflare's analytics API for this zone right now.
			</p>
		))
		.onSuccess((data, r) => {
			if (data.unavailableReason != null) {
				return (
					<p className="px-3 pb-3 font-mono text-[11px] text-muted-foreground">
						Cloudflare can't serve this breakdown: {data.unavailableReason}
					</p>
				)
			}
			return (
				<div className={cn("transition-opacity", r.waiting && "opacity-60")}>
					<TableShell
						ariaLabel={`Live ${dimension.column} search`}
						waiting={r.waiting}
						isEmpty={data.rows.length === 0}
						emptyMessage={`No ${dimension.column.toLowerCase()} matches "${query}" in this window.`}
						header={
							<>
								<ColumnHead label={dimension.column} width="flex-1 min-w-[220px]" />
								<ColumnHead label="Requests" align="right" width="w-[110px]" />
								<ColumnHead label="Error rate" align="right" width="w-[90px]" />
								<ColumnHead
									label="Bandwidth"
									align="right"
									width="w-[90px]"
									hidden="hidden md:flex"
								/>
							</>
						}
					>
						{data.rows.map((row) => (
							<div key={row.key} className={ROW_CLASS}>
								<div className="min-w-[220px] flex-1 truncate font-mono text-[13px] text-foreground">
									{row.key}
								</div>
								<div className="w-[110px] text-right font-mono text-[12px] tabular-nums text-foreground/80">
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
						))}
					</TableShell>
					<p className="px-3 pt-2 font-mono text-[10px] text-muted-foreground">
						Live from Cloudflare · no history in this mode
					</p>
				</div>
			)
		})
		.render()
}
