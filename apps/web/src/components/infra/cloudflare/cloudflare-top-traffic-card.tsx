// Live top hosts / top paths for one zone, fetched from Cloudflare's GraphQL
// API through our proxy endpoint (edge-cached ~60s). Paths are never stored
// as metrics — this card is the only path-level view, so it stays visible even
// when empty and explains itself when Cloudflare can't serve the window.

import { useMemo, useState } from "react"

import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { cloudflareTopTrafficResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { formatNumber } from "@/lib/format"
import { ColumnHead, TableShell } from "../primitives/data-table"
import { formatPercent } from "../format"
import { errorRateClass } from "./constants"
import { formatBytes } from "./format"

const ROW_CLASS =
	"flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0 hover:bg-muted/40"

const warehouseTimeToMs = (value: string) => new Date(value.replace(" ", "T") + "Z").getTime()

type Dimension = "host" | "path"

export function CloudflareTopTrafficCard({
	zoneName,
	startTime,
	endTime,
}: {
	zoneName: string
	/** Warehouse datetime strings (`YYYY-MM-DD HH:mm:ss`), same as the sibling sections. */
	startTime: string
	endTime: string
}) {
	const [dimension, setDimension] = useState<Dimension>("path")
	const { startMs, endMs } = useMemo(
		() => ({ startMs: warehouseTimeToMs(startTime), endMs: warehouseTimeToMs(endTime) }),
		[startTime, endTime],
	)

	const result = useAtomValue(
		cloudflareTopTrafficResultAtom({
			data: { zoneName, dimension, startTime: startMs, endTime: endMs, limit: 15 },
		}),
	)

	const toggle = (
		<div className="flex items-center gap-1" role="tablist" aria-label="Top traffic dimension">
			{(["path", "host"] as const).map((value) => (
				<button
					key={value}
					type="button"
					role="tab"
					aria-selected={dimension === value}
					onClick={() => setDimension(value)}
					className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
						dimension === value
							? "bg-muted font-medium text-foreground"
							: "text-muted-foreground hover:text-foreground"
					}`}
				>
					{value === "path" ? "Paths" : "Hosts"}
				</button>
			))}
		</div>
	)

	return (
		<div className="rounded-md border bg-card">
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 pt-2.5 pb-2">
				<span className="text-[11px] font-medium text-muted-foreground">
					Top {dimension === "path" ? "paths" : "hosts"} · live from Cloudflare
				</span>
				{toggle}
			</div>
			{Result.builder(result)
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
						<div className={`content-enter ${r.waiting ? "opacity-60" : ""}`}>
							<TableShell
								ariaLabel={`Top ${dimension}s`}
								waiting={r.waiting}
								isEmpty={data.rows.length === 0}
								emptyMessage="No traffic in the selected window."
								header={
									<>
										<ColumnHead
											label={dimension === "path" ? "Path" : "Host"}
											width="flex-1 min-w-[220px]"
										/>
										<ColumnHead label="Requests" align="right" width="w-[90px]" />
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
										<div className="w-[90px] text-right font-mono text-[12px] tabular-nums text-foreground/80">
											{formatNumber(row.requests)}
										</div>
										<div
											className={`w-[90px] text-right font-mono text-[12px] tabular-nums ${errorRateClass(row.errorRate)}`}
										>
											{formatPercent(row.errorRate)}
										</div>
										<div className="hidden w-[90px] text-right font-mono text-[12px] tabular-nums text-foreground/80 md:block">
											{formatBytes(row.bytes)}
										</div>
									</div>
								))}
							</TableShell>
						</div>
					)
				})
				.render()}
		</div>
	)
}
