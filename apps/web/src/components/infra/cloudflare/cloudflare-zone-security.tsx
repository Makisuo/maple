// Firewall/WAF activity for one zone: event timeline stacked by action plus
// the heaviest (source, action, rule, host) combinations. Hides itself when
// the window has no security events — most zones most of the time.

import { useMemo } from "react"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { cloudflareZoneSecurityResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { formatNumber } from "@/lib/format"
import { ColumnHead, TableShell } from "../primitives/data-table"
import { StackedBreakdownChart } from "./cloudflare-zone-detail-charts"

// Actions carry severity: outright blocks render hot, challenges in the warn
// ramp, pass-through actions (skip/log/allow) stay muted.
const ACTION_COLORS: Record<string, string> = {
	block: "var(--severity-error)",
	drop: "var(--severity-error)",
	challenge: "var(--severity-warn)",
	jschallenge: "color-mix(in oklab, var(--severity-warn) 75%, transparent)",
	managed_challenge: "color-mix(in oklab, var(--severity-warn) 55%, transparent)",
	skip: "color-mix(in oklab, var(--muted-foreground) 55%, transparent)",
	log: "color-mix(in oklab, var(--muted-foreground) 40%, transparent)",
	allow: "var(--severity-info)",
	unknown: "color-mix(in oklab, var(--muted-foreground) 25%, transparent)",
}

const ACTION_ORDER = [
	"block",
	"drop",
	"challenge",
	"jschallenge",
	"managed_challenge",
	"skip",
	"log",
	"allow",
	"unknown",
]

const ROW_CLASS =
	"flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0 hover:bg-muted/40"

export function CloudflareZoneSecuritySection({
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
		cloudflareZoneSecurityResultAtom({ data: { serviceName, startTime, endTime, bucketSeconds } }),
	)

	return Result.builder(result)
		.onSuccess((data, r) => {
			if (data.buckets.length === 0 && data.top.length === 0) return null
			const rows = data.buckets.map((bucket) => ({
				bucket: bucket.bucket,
				attributeValue: bucket.action,
				value: bucket.events,
			}))
			return (
				<div className={`space-y-4 transition-opacity ${r.waiting ? "opacity-60" : ""}`}>
					<StackedBreakdownChart
						title="Security events by action"
						rows={rows}
						colors={ACTION_COLORS}
						order={ACTION_ORDER}
						syncId={syncId}
					/>
					<SecurityTopTable top={data.top} waiting={r.waiting} />
				</div>
			)
		})
		.orElse(() => null)
}

function SecurityTopTable({
	top,
	waiting,
}: {
	top: ReadonlyArray<{ source: string; action: string; ruleId: string; host: string; events: number }>
	waiting?: boolean
}) {
	const rows = useMemo(() => [...top].sort((a, b) => b.events - a.events), [top])
	return (
		<TableShell
			ariaLabel="Top security rules"
			waiting={waiting}
			isEmpty={rows.length === 0}
			emptyMessage="No security events in the selected window."
			header={
				<>
					<ColumnHead label="Rule" width="flex-1 min-w-[200px]" />
					<ColumnHead label="Source" width="w-[130px]" hidden="hidden md:flex" />
					<ColumnHead label="Action" width="w-[130px]" />
					<ColumnHead label="Host" width="w-[180px]" hidden="hidden lg:flex" />
					<ColumnHead label="Events" align="right" width="w-[90px]" />
				</>
			}
		>
			{rows.map((row) => (
				<div key={`${row.source}:${row.action}:${row.ruleId}:${row.host}`} className={ROW_CLASS}>
					<div className="min-w-[200px] flex-1 truncate font-mono text-[13px] text-foreground">
						{row.ruleId}
					</div>
					<div className="hidden w-[130px] truncate font-mono text-[12px] text-foreground/80 md:block">
						{row.source}
					</div>
					<div className="w-[130px] truncate font-mono text-[12px] text-foreground/80">{row.action}</div>
					<div className="hidden w-[180px] truncate font-mono text-[12px] text-foreground/80 lg:block">
						{row.host}
					</div>
					<div className="w-[90px] text-right font-mono text-[12px] tabular-nums text-foreground/80">
						{formatNumber(row.events)}
					</div>
				</div>
			))}
		</TableShell>
	)
}
