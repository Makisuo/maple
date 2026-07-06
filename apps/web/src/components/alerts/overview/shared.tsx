import type {
	AlertDestinationDocument,
	AlertIncidentDocument,
} from "@maple/domain/http"

import { CircleWarningIcon } from "@/components/icons"
import { ProviderLogo } from "@/components/alerts/destination-provider"
import { signalLabels } from "@/lib/alerts/form-utils"
import { Badge } from "@maple/ui/components/ui/badge"
import { TableCell, TableRow } from "@maple/ui/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/utils"

/* -------------------------------------------------------------------------- */
/*  Signal badge tone                                                         */
/* -------------------------------------------------------------------------- */

const signalBadgeClass: Record<string, string> = {
	error_rate: "border-destructive/30 text-destructive",
	p95_latency: "border-primary/30 text-primary",
	p99_latency: "border-primary/30 text-primary",
	apdex: "border-severity-warn/30 text-severity-warn",
	// Throughput rides the dedicated chart-throughput hue so the chip stays
	// distinguishable from the amber p95/apdex chips (see DESIGN.md).
	throughput: "border-[var(--chart-throughput)]/30 text-[var(--chart-throughput)]",
	metric: "border-muted-foreground/30 text-muted-foreground",
	query: "border-muted-foreground/30 text-muted-foreground",
}

export function SignalBadge({ signalType }: { signalType: string }) {
	return (
		<Badge variant="outline" className={cn("text-xs", signalBadgeClass[signalType])}>
			{signalLabels[signalType as keyof typeof signalLabels] ?? signalType}
		</Badge>
	)
}

/** Secondary-tone tag chips, kept visually distinct from outline service badges. */
export function TagChips({ tags }: { tags: readonly string[] }) {
	if (tags.length === 0) return null
	return (
		<div className="mt-1 flex flex-wrap gap-1">
			{tags.map((tag) => (
				<Badge key={tag} variant="secondary" size="sm">
					{tag}
				</Badge>
			))}
		</div>
	)
}

/** Group-header row reused by the grouped rules and incidents tables. */
export function TagGroupHeaderRow({
	label,
	count,
	noun,
	colSpan,
}: {
	label: string
	count: number
	noun: string
	colSpan: number
}) {
	return (
		<TableRow>
			<TableCell
				colSpan={colSpan}
				className="bg-muted/30 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
			>
				<span className="flex items-center gap-2">
					{label}
					<span className="tracking-normal normal-case text-muted-foreground/55 tabular-nums">
						{count} {count === 1 ? noun : `${noun}s`}
					</span>
				</span>
			</TableCell>
		</TableRow>
	)
}

/**
 * Notify cell. Shows the real provider marks a rule routes to (joined from the
 * already-loaded destinations) instead of an opaque count. An enabled rule with
 * no destination is surfaced as a warning — it can page no one.
 */
export function NotifyChannels({
	destinations,
	enabled,
}: {
	destinations: AlertDestinationDocument[]
	enabled: boolean
}) {
	if (destinations.length === 0) {
		if (!enabled) return <span className="text-muted-foreground text-xs">No channel</span>
		return (
			<Tooltip>
				<TooltipTrigger
					render={
						<span className="inline-flex cursor-default items-center gap-1 text-warning text-xs" />
					}
				>
					<CircleWarningIcon size={12} />
					No channel
				</TooltipTrigger>
				<TooltipContent>Enabled but routed nowhere — this rule can notify no one.</TooltipContent>
			</Tooltip>
		)
	}

	const shown = destinations.slice(0, 3)
	const extra = destinations.length - shown.length
	return (
		<Tooltip>
			<TooltipTrigger render={<span className="inline-flex cursor-default items-center gap-1.5" />}>
				<span className="flex items-center gap-1">
					{shown.map((d) => (
						<ProviderLogo key={d.id} type={d.type} size={28} bare className="flex items-center" />
					))}
				</span>
				{extra > 0 && <span className="text-muted-foreground text-xs tabular-nums">+{extra}</span>}
			</TooltipTrigger>
			<TooltipContent>{destinations.map((d) => d.name).join(", ")}</TooltipContent>
		</Tooltip>
	)
}

/** Critical before warning, then most-recently-triggered first. */
const severityRank: Record<string, number> = { critical: 0, warning: 1 }
export function sortIncidents(incidents: readonly AlertIncidentDocument[]): AlertIncidentDocument[] {
	return [...incidents].sort((a, b) => {
		const bySeverity = (severityRank[a.severity] ?? 2) - (severityRank[b.severity] ?? 2)
		if (bySeverity !== 0) return bySeverity
		const ta = a.lastTriggeredAt ? new Date(a.lastTriggeredAt).getTime() : 0
		const tb = b.lastTriggeredAt ? new Date(b.lastTriggeredAt).getTime() : 0
		return tb - ta
	})
}
