import { Link } from "@tanstack/react-router"
import { formatErrorRate, formatLatency, formatNumber } from "@maple/ui/lib/format"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"

import { SectionCard } from "@/components/services/section-card"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { CommitShaHoverCard } from "@/components/vcs/commit-sha-hover-card"
import { ReleaseHealthPill, releaseHealthFigure } from "./release-health"
import { MIN_COMPARE_SPANS, shortReleaseLabel, type ReleaseServiceImpact } from "./release-model"

interface ComparisonRow {
	label: string
	value: number
	baseline: number | undefined
	format: (value: number) => string
	/** Change as a ratio of the baseline; `undefined` when the row has no meaningful change. */
	change: number | undefined
	/** Whether a positive change is bad (errors, latency) or good (apdex). */
	direction: "lower-is-better" | "higher-is-better" | "neutral"
}

function changeTone(row: ComparisonRow): string {
	if (row.change === undefined || row.direction === "neutral") return "text-muted-foreground"
	const bad = row.direction === "lower-is-better" ? row.change > 0 : row.change < 0
	const magnitude = Math.abs(row.change)
	if (!bad || magnitude < 0.1) return "text-muted-foreground"
	return magnitude >= 1 ? "text-severity-error" : "text-severity-warn"
}

function formatChange(row: ComparisonRow): string {
	if (row.change === undefined) return "—"
	if (row.direction === "lower-is-better" && row.change >= 1) return `${(1 + row.change).toFixed(1)}×`
	if (!Number.isFinite(row.change)) return "from 0"
	const pct = Math.round(row.change * 100)
	return `${pct > 0 ? "+" : ""}${pct}%`
}

const ratioChange = (value: number, baseline: number | undefined): number | undefined =>
	baseline === undefined
		? undefined
		: baseline > 0
			? (value - baseline) / baseline
			: value > 0
				? Number.POSITIVE_INFINITY
				: 0

/**
 * This version against every other version of the same service in the same
 * window. Rows are the golden signals the charts below draw; the change column
 * is the figure the health band was derived from.
 */
export function ReleaseComparison({ impact }: { impact: ReleaseServiceImpact }) {
	const baseline = impact.baseline
	const comparable =
		baseline !== undefined &&
		impact.spanCount >= MIN_COMPARE_SPANS &&
		baseline.spanCount >= MIN_COMPARE_SPANS
	const rows: ComparisonRow[] = [
		{
			label: "Requests",
			value: impact.spanCount,
			baseline: baseline?.spanCount,
			format: formatNumber,
			change: undefined,
			direction: "neutral",
		},
		{
			label: "Error rate",
			value: impact.errorRate,
			baseline: baseline?.errorRate,
			format: formatErrorRate,
			change: comparable ? ratioChange(impact.errorRate, baseline?.errorRate) : undefined,
			direction: "lower-is-better",
		},
		{
			label: "p50",
			value: impact.p50LatencyMs,
			baseline: baseline?.p50LatencyMs,
			format: formatLatency,
			change: comparable ? ratioChange(impact.p50LatencyMs, baseline?.p50LatencyMs) : undefined,
			direction: "lower-is-better",
		},
		{
			label: "p95",
			value: impact.p95LatencyMs,
			baseline: baseline?.p95LatencyMs,
			format: formatLatency,
			change: comparable ? ratioChange(impact.p95LatencyMs, baseline?.p95LatencyMs) : undefined,
			direction: "lower-is-better",
		},
		{
			label: "p99",
			value: impact.p99LatencyMs,
			baseline: baseline?.p99LatencyMs,
			format: formatLatency,
			change: comparable ? ratioChange(impact.p99LatencyMs, baseline?.p99LatencyMs) : undefined,
			direction: "lower-is-better",
		},
		{
			label: "Apdex",
			value: impact.apdexScore,
			baseline: baseline?.apdexScore,
			format: (value) => value.toFixed(2),
			change: comparable ? ratioChange(impact.apdexScore, baseline?.apdexScore) : undefined,
			direction: "higher-is-better",
		},
	]

	const baselineLabel =
		baseline === undefined
			? "no other version"
			: baseline.versions === 1
				? "1 other version"
				: `${baseline.versions} other versions`

	return (
		<SectionCard
			title="This version vs. the rest of the service"
			action={
				<span className="text-[11px] text-muted-foreground/70" title="Same window, split by version">
					{baselineLabel}
				</span>
			}
		>
			{baseline === undefined ? (
				<div className="px-4 py-6 text-center text-xs text-muted-foreground">
					Only one version of this service reported in the window, so there is nothing to compare
					against. Widen the time range to include the previous version.
				</div>
			) : (
				<table className="w-full text-xs">
					<thead>
						<tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
							<th className="px-4 py-1.5 text-left font-medium" />
							<th className="px-2 py-1.5 text-right font-medium">
								<span className="font-mono normal-case tracking-normal">
									{shortReleaseLabel(impact.commitSha)}
								</span>
							</th>
							<th className="px-2 py-1.5 text-right font-medium">Others</th>
							<th className="px-4 py-1.5 text-right font-medium">Change</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.label} className="border-t border-border/60">
								<td className="px-4 py-1.5 text-muted-foreground">{row.label}</td>
								<td className="px-2 py-1.5 text-right font-mono tabular-nums">
									{row.format(row.value)}
								</td>
								<td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
									{row.baseline === undefined ? "—" : row.format(row.baseline)}
								</td>
								<td
									className={cn(
										"px-4 py-1.5 text-right font-mono tabular-nums",
										changeTone(row),
									)}
								>
									{formatChange(row)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{baseline !== undefined && !comparable ? (
				<div className="border-t px-4 py-2 text-[11px] text-muted-foreground/70">
					Changes are withheld below {MIN_COMPARE_SPANS} requests on either side.
				</div>
			) : null}
		</SectionCard>
	)
}

interface ReleaseVersionsRailProps {
	impacts: ReadonlyArray<ReleaseServiceImpact>
	currentSha: string
	serviceName: string
	environments?: string[]
	timeSearch: TimeRangeSearch
}

/** Every version of the service in the window, newest first; the current one is pinned. */
export function ReleaseVersionsRail({
	impacts,
	currentSha,
	serviceName,
	environments,
	timeSearch,
}: ReleaseVersionsRailProps) {
	const sorted = impacts.toSorted((a, b) =>
		a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : 0,
	)
	return (
		<SectionCard
			title="Versions in window"
			action={
				<span className="text-[11px] text-muted-foreground/70">
					{sorted.length === 1 ? "1 version" : `${sorted.length} versions`}
				</span>
			}
		>
			<div className="max-h-80 space-y-px overflow-y-auto p-2">
				{sorted.map((version) => {
					const isCurrent = version.commitSha === currentSha
					return (
						<Link
							key={`${version.commitSha}:${version.environment}`}
							to="/releases/$commitSha"
							params={{ commitSha: version.commitSha }}
							search={{
								service: serviceName,
								environments:
									environments ?? (version.environment ? [version.environment] : undefined),
								...timeSearch,
							}}
							className={cn(
								"flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-xs transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
								isCurrent && "bg-muted/60",
							)}
						>
							<CommitShaHoverCard sha={version.commitSha} className="font-mono text-foreground">
								{shortReleaseLabel(version.commitSha)}
							</CommitShaHoverCard>
							{version.health === "healthy" ? null : (
								<ReleaseHealthPill
									health={version.health}
									label={releaseHealthFigure(version)}
								/>
							)}
							<span className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground">
								{formatNumber(version.spanCount)}
							</span>
							<span
								className="w-16 shrink-0 text-right font-mono tabular-nums text-muted-foreground/70"
								title={new Date(version.firstSeen).toLocaleString()}
							>
								{formatRelativeTimeOrDate(version.firstSeen)}
							</span>
						</Link>
					)
				})}
			</div>
		</SectionCard>
	)
}
