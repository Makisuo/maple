import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"

import type { CloudflareZoneRow } from "@/api/warehouse/cloudflare-infra"
import { formatLatency, formatNumber } from "@/lib/format"
import { ColumnHead, ROW_LINK_CLASS, TableShell, TableSkeleton, useTableSort } from "../primitives/data-table"
import { formatPercent } from "../format"
import { formatBytes } from "./format"

// Zone latency percentiles are plan-dependent (the poller only gets quantiles
// on zones whose Cloudflare plan exposes them); 0 means "not available", not
// a zero-millisecond edge response.
const formatOptionalLatency = (ms: number) => (ms > 0 ? formatLatency(ms) : "—")

type SortKey =
	| "zoneName"
	| "requests"
	| "errorRate"
	| "cacheHitRate"
	| "bytes"
	| "visits"
	| "ttfbP50Ms"
	| "ttfbP99Ms"
	| "originP99Ms"

interface CloudflareZoneTableProps {
	zones: ReadonlyArray<CloudflareZoneRow>
	waiting?: boolean
}

export function CloudflareZoneTableLoading() {
	return (
		<TableSkeleton
			rows={3}
			header={
				<>
					<ColumnHead label="Zone" width="flex-1 min-w-[220px]" />
					<ColumnHead label="Requests" align="right" width="w-[90px]" />
					<ColumnHead label="Error rate" align="right" width="w-[90px]" />
					<ColumnHead label="Cache hit" align="right" width="w-[90px]" hidden="hidden md:flex" />
					<ColumnHead label="Bandwidth" align="right" width="w-[90px]" hidden="hidden md:flex" />
					<ColumnHead label="TTFB p99" align="right" width="w-[90px]" />
				</>
			}
			renderRowCells={() => (
				<>
					<div className="min-w-[220px] flex-1">
						<Skeleton className="h-4 w-44" />
					</div>
					<Skeleton className="h-3 w-[90px]" />
					<Skeleton className="h-3 w-[90px]" />
					<Skeleton className="hidden h-3 w-[90px] md:block" />
					<Skeleton className="hidden h-3 w-[90px] md:block" />
					<Skeleton className="h-3 w-[90px]" />
				</>
			)}
		/>
	)
}

export function CloudflareZoneTable({ zones, waiting }: CloudflareZoneTableProps) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<CloudflareZoneRow, SortKey>(zones, {
		initialKey: "requests",
		stringKeys: ["zoneName"],
	})

	const numCell = (value: string, hidden?: boolean) => (
		<div
			className={`w-[90px] text-right font-mono text-[12px] tabular-nums text-foreground/80 ${
				hidden ? "hidden md:block" : ""
			}`}
		>
			{value}
		</div>
	)

	return (
		<TableShell
			ariaLabel="Cloudflare zones"
			waiting={waiting}
			isEmpty={sorted.length === 0}
			emptyMessage="No zone traffic in the selected window."
			header={
				<>
					<ColumnHead<SortKey>
						label="Zone"
						sortKey="zoneName"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						width="flex-1 min-w-[220px]"
					/>
					<ColumnHead<SortKey>
						label="Requests"
						sortKey="requests"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[90px]"
					/>
					<ColumnHead<SortKey>
						label="Error rate"
						sortKey="errorRate"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[90px]"
					/>
					<ColumnHead<SortKey>
						label="Cache hit"
						sortKey="cacheHitRate"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[90px]"
						hidden="hidden md:flex"
					/>
					<ColumnHead<SortKey>
						label="Bandwidth"
						sortKey="bytes"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[90px]"
						hidden="hidden md:flex"
					/>
					<ColumnHead<SortKey>
						label="Visits"
						sortKey="visits"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[90px]"
						hidden="hidden lg:flex"
					/>
					<ColumnHead<SortKey>
						label="TTFB p50"
						sortKey="ttfbP50Ms"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[90px]"
						hidden="hidden lg:flex"
					/>
					<ColumnHead<SortKey>
						label="TTFB p99"
						sortKey="ttfbP99Ms"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[90px]"
					/>
					<ColumnHead<SortKey>
						label="Origin p99"
						sortKey="originP99Ms"
						currentKey={sortKey}
						dir={sortDir}
						onSort={handleSort}
						align="right"
						width="w-[90px]"
						hidden="hidden lg:flex"
					/>
				</>
			}
		>
			{sorted.map((zone) => (
				<Link
					key={zone.serviceName}
					to="/infra/cloudflare/$zoneName"
					params={{ zoneName: zone.zoneName }}
					className={ROW_LINK_CLASS}
				>
					<div className="min-w-[220px] flex-1 truncate font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-primary">
						{zone.zoneName}
					</div>
					{numCell(formatNumber(zone.requests))}
					<div
						className={`w-[90px] text-right font-mono text-[12px] tabular-nums ${
							zone.errorRate >= 0.05
								? "text-destructive"
								: zone.errorRate >= 0.01
									? "text-amber-600 dark:text-amber-500"
									: "text-foreground/80"
						}`}
					>
						{formatPercent(zone.errorRate)}
					</div>
					{numCell(formatPercent(zone.cacheHitRate), true)}
					{numCell(formatBytes(zone.bytes), true)}
					<div className="hidden w-[90px] text-right font-mono text-[12px] tabular-nums text-foreground/80 lg:block">
						{formatNumber(zone.visits)}
					</div>
					<div className="hidden w-[90px] text-right font-mono text-[12px] tabular-nums text-foreground/80 lg:block">
						{formatOptionalLatency(zone.ttfbP50Ms)}
					</div>
					{numCell(formatOptionalLatency(zone.ttfbP99Ms))}
					<div className="hidden w-[90px] text-right font-mono text-[12px] tabular-nums text-foreground/80 lg:block">
						{formatOptionalLatency(zone.originP99Ms)}
					</div>
				</Link>
			))}
		</TableShell>
	)
}
