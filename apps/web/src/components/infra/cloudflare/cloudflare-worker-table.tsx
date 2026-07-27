import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { LatencyValue } from "@maple/ui/components/latency-value"

import type { CloudflareWorkerRow } from "@/api/warehouse/cloudflare-infra"
import { formatNumber } from "@maple/ui/format"
import { ColumnHead, DataTable, useTableSort } from "../primitives/data-table"
import { formatPercent } from "@maple/ui/format"
import { errorRateClass } from "./constants"

type SortKey =
	| "scriptName"
	| "requests"
	| "errors"
	| "errorRate"
	| "subrequests"
	| "cpuP99Ms"
	| "durationP99Ms"

interface CloudflareWorkerTableProps {
	workers: ReadonlyArray<CloudflareWorkerRow>
	waiting?: boolean
}

const ROW_CLASS =
	"flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0 hover:bg-muted/40"

// Matches the zone table: the server caps at 500 scripts, so scroll rather than grow the page.
const TABLE_MAX_HEIGHT = 460

export function CloudflareWorkerTableLoading() {
	return (
		<DataTable.Root ariaLabel="Workers">
			<DataTable.Head>
				<ColumnHead label="Script" width="flex-1 min-w-[220px]" />
				<ColumnHead label="Invocations" align="right" width="w-[100px]" />
				<ColumnHead label="Error rate" align="right" width="w-[90px]" />
				<ColumnHead label="CPU p99" align="right" width="w-[90px]" hidden="hidden md:flex" />
				<ColumnHead label="Duration p99" align="right" width="w-[100px]" />
			</DataTable.Head>
			<DataTable.SkeletonRows count={3}>
				<div className="min-w-[220px] flex-1">
					<Skeleton className="h-4 w-44" />
				</div>
				<Skeleton className="h-3 w-[100px]" />
				<Skeleton className="h-3 w-[90px]" />
				<Skeleton className="hidden h-3 w-[90px] md:block" />
				<Skeleton className="h-3 w-[100px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

export function CloudflareWorkerTable({ workers, waiting }: CloudflareWorkerTableProps) {
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<CloudflareWorkerRow, SortKey>(workers, {
		initialKey: "requests",
		stringKeys: ["scriptName"],
	})

	return (
		<DataTable.Root ariaLabel="Cloudflare Workers" waiting={waiting} maxHeight={TABLE_MAX_HEIGHT}>
			<DataTable.Head>
				<ColumnHead<SortKey>
					label="Script"
					sortKey="scriptName"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					width="flex-1 min-w-[220px]"
				/>
				<ColumnHead<SortKey>
					label="Invocations"
					sortKey="requests"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[100px]"
				/>
				<ColumnHead<SortKey>
					label="Errors"
					sortKey="errors"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[90px]"
					hidden="hidden lg:flex"
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
					label="Subrequests"
					sortKey="subrequests"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[100px]"
					hidden="hidden lg:flex"
				/>
				<ColumnHead<SortKey>
					label="CPU p99"
					sortKey="cpuP99Ms"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[90px]"
					hidden="hidden md:flex"
				/>
				<ColumnHead<SortKey>
					label="Duration p99"
					sortKey="durationP99Ms"
					currentKey={sortKey}
					dir={sortDir}
					onSort={handleSort}
					align="right"
					width="w-[100px]"
				/>
			</DataTable.Head>
			{sorted.length === 0 && (
				<DataTable.Empty>No Worker invocations in the selected window.</DataTable.Empty>
			)}

			{sorted.map((worker) => (
				<div key={worker.serviceName} className={ROW_CLASS}>
					<div className="min-w-[220px] flex-1 truncate font-mono text-[13px] font-medium text-foreground">
						{worker.scriptName}
					</div>
					<div className="w-[100px] text-right font-mono text-[12px] tabular-nums text-foreground/80">
						{formatNumber(worker.requests)}
					</div>
					<div className="hidden w-[90px] text-right font-mono text-[12px] tabular-nums text-foreground/80 lg:block">
						{formatNumber(worker.errors)}
					</div>
					<div
						className={`w-[90px] text-right font-mono text-[12px] tabular-nums ${errorRateClass(worker.errorRate)}`}
					>
						{formatPercent(worker.errorRate)}
					</div>
					<div className="hidden w-[100px] text-right font-mono text-[12px] tabular-nums text-foreground/80 lg:block">
						{formatNumber(worker.subrequests)}
					</div>
					<div className="hidden w-[90px] text-right text-[12px] md:block">
						{/* Worker CPU time runs ~20x tighter than wall-clock latency,
						    hence the dedicated "cpu" budget. */}
						<LatencyValue ms={worker.cpuP99Ms} scale="cpu" className="text-[12px]" />
					</div>
					<div className="w-[100px] text-right text-[12px]">
						<LatencyValue ms={worker.durationP99Ms} scale="p99" className="text-[12px]" />
					</div>
				</div>
			))}
		</DataTable.Root>
	)
}
