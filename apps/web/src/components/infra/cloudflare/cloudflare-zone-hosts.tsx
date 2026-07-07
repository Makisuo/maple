// Per-hostname breakdown for one zone. Only renders once host-dimensioned
// datapoints exist (the poller started attaching `http.host` in July 2026);
// older windows have every row under host "" and the section hides itself —
// same convention as the plan-dependent latency panel.

import { Result, useAtomValue } from "@/lib/effect-atom"
import type { CloudflareZoneHostTotal } from "@/api/warehouse/cloudflare-infra"
import { cloudflareZoneHostsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { formatNumber } from "@/lib/format"
import { ColumnHead, TableShell, useTableSort } from "../primitives/data-table"
import { formatPercent } from "../format"
import { StackedBreakdownChart } from "./cloudflare-zone-detail-charts"
import { errorRateClass, OTHER_ZONES_COLOR } from "./constants"
import { formatBytes } from "./format"

const ROW_CLASS =
	"flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0 hover:bg-muted/40"

// Palette-by-index is fine here: hostnames carry no inherent severity, and the
// chart plots at most the poller's top-20 cap (+"other" in the muted ramp).
const HOST_PALETTE = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
] as const

const MAX_CHART_HOSTS = 8

type SortKey = "host" | "requests" | "errorRate" | "cacheHitRate" | "bytes"

function HostTable({ totals, waiting }: { totals: ReadonlyArray<CloudflareZoneHostTotal>; waiting?: boolean }) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<CloudflareZoneHostTotal, SortKey>(totals, {
		initialKey: "requests",
		stringKeys: ["host"],
	})

	return (
		<TableShell
			ariaLabel="Zone hostnames"
			waiting={waiting}
			isEmpty={sorted.length === 0}
			emptyMessage="No per-host traffic in the selected window."
			header={
				<>
					<ColumnHead<SortKey>
						label="Host"
						sortKey="host"
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
				</>
			}
		>
			{sorted.map((row) => (
				<div key={row.host} className={ROW_CLASS}>
					<div className="min-w-[220px] flex-1 truncate font-mono text-[13px] font-medium text-foreground">
						{row.host}
					</div>
					<div className="w-[90px] text-right font-mono text-[12px] tabular-nums text-foreground/80">
						{formatNumber(row.requests)}
					</div>
					<div
						className={`w-[90px] text-right font-mono text-[12px] tabular-nums ${errorRateClass(row.errorRate)}`}
					>
						{formatPercent(row.errorRate)}
					</div>
					<div className="hidden w-[90px] text-right font-mono text-[12px] tabular-nums text-foreground/80 md:block">
						{formatPercent(row.cacheHitRate)}
					</div>
					<div className="hidden w-[90px] text-right font-mono text-[12px] tabular-nums text-foreground/80 md:block">
						{formatBytes(row.bytes)}
					</div>
				</div>
			))}
		</TableShell>
	)
}

export function CloudflareZoneHostsSection({
	serviceName,
	startTime,
	endTime,
	bucketSeconds,
	syncId,
}: {
	serviceName: string
	startTime: string
	endTime: string
	bucketSeconds: number
	syncId?: string
}) {
	const result = useAtomValue(
		cloudflareZoneHostsResultAtom({ data: { serviceName, startTime, endTime, bucketSeconds } }),
	)

	return Result.builder(result)
		.onSuccess((data, r) => {
			// Pre-host-dimension windows put every request under host "" — that
			// tells the reader nothing, so the whole section stays hidden.
			const totals = data.totals.filter((row) => row.host !== "")
			if (totals.length === 0) return null

			const chartHosts = totals.slice(0, MAX_CHART_HOSTS).map((row) => row.host)
			const colorByHost = Object.fromEntries(
				chartHosts.map((host, idx) => [
					host,
					host === "other" ? OTHER_ZONES_COLOR : HOST_PALETTE[idx % HOST_PALETTE.length]!,
				]),
			)
			const chartHostSet = new Set(chartHosts)
			const rows = data.buckets
				.filter((bucket) => bucket.host !== "" && chartHostSet.has(bucket.host))
				.map((bucket) => ({ bucket: bucket.bucket, attributeValue: bucket.host, value: bucket.requests }))

			return (
				<div className={`space-y-4 transition-opacity ${r.waiting ? "opacity-60" : ""}`}>
					<StackedBreakdownChart
						title="Requests by hostname"
						rows={rows}
						colors={colorByHost}
						order={chartHosts}
						syncId={syncId}
					/>
					<HostTable totals={totals} waiting={r.waiting} />
				</div>
			)
		})
		.orElse(() => null)
}
