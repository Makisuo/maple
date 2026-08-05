import { Link } from "@tanstack/react-router"

import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { LatencyValue } from "@maple/ui/components/latency-value"

import type { CloudflareZoneRow } from "@/api/warehouse/cloudflare-infra"
import { formatLatency, formatNumber } from "@maple/ui/lib/format"
import { ColumnHead, DataTable, ROW_LINK_CLASS, useTableSort } from "../primitives/data-table"
import { formatBytes, formatPercent } from "@maple/ui/lib/format"
import { errorRateClass } from "./constants"

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

// The server caps the list at 500 zones, so the row area scrolls rather than pushing every section
// below it off the page. Roughly nine rows before the scroll starts.
const TABLE_MAX_HEIGHT = 460

interface CloudflareZoneTableProps {
	zones: ReadonlyArray<CloudflareZoneRow>
	waiting?: boolean
	/** Overrides the "no traffic" empty when the list is empty because of a filter, not the window. */
	emptyMessage?: string
}

export function CloudflareZoneTableLoading() {
	return (
		<DataTable.Root ariaLabel="Zones">
			<DataTable.Head>
				<ColumnHead label="Zone" width="flex-1 min-w-[220px]" />
				<ColumnHead label="Requests" align="right" width="w-[90px]" />
				<ColumnHead label="Error rate" align="right" width="w-[90px]" />
				<ColumnHead label="Cache hit" align="right" width="w-[90px]" hidden="hidden md:flex" />
				<ColumnHead label="Bandwidth" align="right" width="w-[90px]" hidden="hidden md:flex" />
				<ColumnHead label="TTFB p99" align="right" width="w-[90px]" />
			</DataTable.Head>
			<DataTable.SkeletonRows count={3}>
				<div className="min-w-[220px] flex-1">
					<Skeleton className="h-4 w-44" />
				</div>
				<Skeleton className="h-3 w-[90px]" />
				<Skeleton className="h-3 w-[90px]" />
				<Skeleton className="hidden h-3 w-[90px] md:block" />
				<Skeleton className="hidden h-3 w-[90px] md:block" />
				<Skeleton className="h-3 w-[90px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

export function CloudflareZoneTable({ zones, waiting, emptyMessage }: CloudflareZoneTableProps) {
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
		<DataTable.Root ariaLabel="Cloudflare zones" waiting={waiting} maxHeight={TABLE_MAX_HEIGHT}>
			<DataTable.Head>
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
			</DataTable.Head>
			{sorted.length === 0 && (
				<DataTable.Empty>{emptyMessage ?? "No zone traffic in the selected window."}</DataTable.Empty>
			)}

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
						className={`w-[90px] text-right font-mono text-[12px] tabular-nums ${errorRateClass(zone.errorRate)}`}
					>
						{formatPercent(zone.errorRate)}
					</div>
					{numCell(formatPercent(zone.cacheHitRate), true)}
					{numCell(formatBytes(zone.bytes), true)}
					<div className="hidden w-[90px] text-right font-mono text-[12px] tabular-nums text-foreground/80 lg:block">
						{formatNumber(zone.visits)}
					</div>
					<div className="hidden w-[90px] text-right text-[12px] lg:block">
						<LatencyValue
							ms={zone.ttfbP50Ms}
							scale="p50"
							format={formatOptionalLatency}
							className="text-[12px]"
						/>
					</div>
					<div className="w-[90px] text-right text-[12px]">
						<LatencyValue
							ms={zone.ttfbP99Ms}
							scale="p99"
							format={formatOptionalLatency}
							className="text-[12px]"
						/>
					</div>
					<div className="hidden w-[90px] text-right text-[12px] lg:block">
						<LatencyValue
							ms={zone.originP99Ms}
							scale="p99"
							format={formatOptionalLatency}
							className="text-[12px]"
						/>
					</div>
				</Link>
			))}
		</DataTable.Root>
	)
}
