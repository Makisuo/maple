// Authoritative-DNS analytics for one zone: query timeline stacked by
// response code plus the heaviest query names (effectively a subdomain
// breakdown). Only zones on Cloudflare DNS produce this dataset — everyone
// else gets zero rows and the section hides itself.

import { useMemo } from "react"

import { Result } from "@/lib/effect-atom"
import { cloudflareZoneDnsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useRetainedRefreshableResultValue } from "@/hooks/use-retained-refreshable-result-value"
import { formatNumber } from "@maple/ui/lib/format"
import { ColumnHead, DataTable } from "../primitives/data-table"
import { formatPercent } from "@maple/ui/lib/format"
import { StackedBreakdownChart } from "./cloudflare-zone-detail-charts"
import { PanelScope } from "./panel-scope"
import type { CloudflareFilters } from "./filters"

// NOERROR is healthy; NXDOMAIN is the interesting signal (typo storms,
// subdomain scanning); server-side failures render hot.
const RESPONSE_CODE_COLORS: Record<string, string> = {
	NOERROR: "var(--severity-info)",
	NXDOMAIN: "var(--severity-warn)",
	SERVFAIL: "var(--severity-error)",
	REFUSED: "color-mix(in oklab, var(--severity-error) 60%, transparent)",
	unknown: "color-mix(in oklab, var(--muted-foreground) 35%, transparent)",
} satisfies Record<string, string>

const RESPONSE_CODE_ORDER = ["NOERROR", "NXDOMAIN", "SERVFAIL", "REFUSED", "unknown"]

const ROW_CLASS =
	"flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0 hover:bg-muted/40"

export function CloudflareZoneDnsSection({
	serviceName,
	startTime,
	endTime,
	bucketSeconds,
	filters,
	syncId,
}: {
	serviceName: string
	startTime: string
	endTime: string
	bucketSeconds: number
	filters: CloudflareFilters
	syncId?: string
}) {
	// Retained for the same reason as the security section: an empty result hides the whole panel.
	const result = useRetainedRefreshableResultValue(
		cloudflareZoneDnsResultAtom({
			data: { serviceName, startTime, endTime, bucketSeconds, ...filters },
		}),
	)

	return Result.builder(result)
		.onSuccess((data, r) => {
			if (data.buckets.length === 0 && data.names.length === 0) return null
			const rows = data.buckets.map((bucket) => ({
				bucket: bucket.bucket,
				attributeValue: bucket.responseCode,
				value: bucket.queries,
			}))
			return (
				<div className={`space-y-4 transition-opacity ${r.waiting ? "opacity-60" : ""}`}>
					<StackedBreakdownChart
						title="DNS queries by response code"
						rows={rows}
						colors={RESPONSE_CODE_COLORS}
						order={RESPONSE_CODE_ORDER}
						syncId={syncId}
						scope={
							<PanelScope
								filters={filters}
								ignoredFilters={data.ignoredFilters}
								reason="DNS analytics is a separate dataset with its own dimensions"
							/>
						}
					/>
					<DnsNamesTable names={data.names} waiting={r.waiting} />
				</div>
			)
		})
		.orElse(() => null)
}

function DnsNamesTable({
	names,
	waiting,
}: {
	names: ReadonlyArray<{ queryName: string; queries: number; nxdomain: number }>
	waiting?: boolean
}) {
	const rows = useMemo(() => [...names].sort((a, b) => b.queries - a.queries), [names])
	return (
		<DataTable.Root ariaLabel="Top DNS query names" waiting={waiting}>
			<DataTable.Head>
				<ColumnHead label="Query name" width="flex-1 min-w-[220px]" />
				<ColumnHead label="Queries" align="right" width="w-[100px]" />
				<ColumnHead label="NXDOMAIN" align="right" width="w-[110px]" />
			</DataTable.Head>
			{rows.length === 0 && <DataTable.Empty>No DNS queries in the selected window.</DataTable.Empty>}

			{rows.map((row) => (
				<div key={row.queryName} className={ROW_CLASS}>
					<div className="min-w-[220px] flex-1 truncate font-mono text-[13px] text-foreground">
						{row.queryName}
					</div>
					<div className="w-[100px] text-right font-mono text-[12px] tabular-nums text-foreground/80">
						{formatNumber(row.queries)}
					</div>
					<div className="w-[110px] text-right font-mono text-[12px] tabular-nums text-foreground/80">
						{row.queries > 0 ? formatPercent(row.nxdomain / row.queries) : "—"}
					</div>
				</div>
			))}
		</DataTable.Root>
	)
}
