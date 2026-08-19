import type { ErrorIssueDocument } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"

import { normalizeTimestampInput } from "@/lib/timezone-format"

/**
 * The issue's numbers, in named lanes, at the top of the page.
 *
 * These used to live in the rail as a "Activity" group of four right-aligned
 * rows, 288px away from the chart they describe, under a heading with exactly
 * the same typography as every section heading in the main column — so the two
 * read at the same rank and neither won. Worse, one of them was labelled
 * "Events (window)" on a page that had no window control at all.
 *
 * `regressionCount`, `lastRegressedAt`, `resolvedVersions` and `snoozeUntil`
 * were fetched on every load and drawn nowhere, which meant the page could not
 * answer the question the whole workflow exists for: did the fix hold.
 */
export function IssueFactStrip({
	issue,
	windowCount,
	windowLabel,
}: {
	issue: ErrorIssueDocument
	/** Occurrences inside the selected range, summed from the detail timeseries. */
	windowCount: number
	/** What the user picked, e.g. "12h" — so the lane names its own scope. */
	windowLabel: string
}) {
	return (
		<div className={STRIP}>
			<Lane label={`Events · ${windowLabel}`}>
				<Count value={windowCount} />
			</Lane>
			<Lane label="Events · all time">
				<Count value={issue.occurrenceCount} />
			</Lane>
			<Lane label="First seen">
				<Stamp iso={issue.firstSeenAt} />
			</Lane>
			<Lane label="Last seen">
				<Stamp iso={issue.lastSeenAt} />
			</Lane>
			{issue.regressionCount > 0 ? (
				<Lane label="Regressions">
					<span className="text-foreground">
						<span className="tabular-nums">{issue.regressionCount}</span>
						{issue.lastRegressedAt ? (
							<span className="text-muted-foreground">
								{" "}
								· last {formatRelativeTime(issue.lastRegressedAt)}
							</span>
						) : null}
					</span>
				</Lane>
			) : issue.lastResolvedAt ? (
				// No regressions *and* a past resolution is the good outcome, and it is
				// worth stating — an empty lane would read as "never fixed".
				<Lane label="Fix held since">
					<Stamp iso={issue.lastResolvedAt} />
				</Lane>
			) : null}
			{issue.resolvedVersions.length > 0 ? (
				<Lane label="Resolved in">
					<span
						className="block truncate font-mono text-xs text-foreground"
						title={issue.resolvedVersions.join(", ")}
					>
						{issue.resolvedVersions.join(", ")}
					</span>
				</Lane>
			) : null}
			{issue.snoozeUntil ? (
				<Lane label="Snoozed until">
					<Stamp iso={issue.snoozeUntil} />
				</Lane>
			) : null}
		</div>
	)
}

function Count({ value }: { value: number }) {
	return (
		<span className="text-foreground tabular-nums" title={value.toLocaleString()}>
			{formatNumber(value)}
		</span>
	)
}

function Stamp({ iso }: { iso: string }) {
	return (
		<span
			className="text-foreground tabular-nums"
			title={new Date(normalizeTimestampInput(iso)).toLocaleString()}
		>
			{formatRelativeTime(iso)}
		</span>
	)
}

/**
 * A grid, not a flex row with divider elements between the lanes — copied from
 * `investigations/impact-strip.tsx`, whose comment explains why: fixed lane
 * widths plus standalone dividers only line up at one viewport, and a wrapped
 * last lane strands its divider at the end of the row above. A grid column
 * cannot strand a separator, because the separator *is* the cell's left border.
 */
const STRIP = [
	"grid shrink-0 gap-y-5 px-1",
	"grid-cols-2 xl:grid-cols-4",
	"[&>*]:border-l [&>*]:pl-6",
	// 2-up: every odd cell starts a row.
	"[&>*:nth-child(odd)]:border-l-0 [&>*:nth-child(odd)]:pl-0",
	// 4-up: only the first cell does, so the odd rule has to be undone.
	"xl:[&>*:nth-child(odd)]:border-l xl:[&>*:nth-child(odd)]:pl-6",
	"xl:[&>*:first-child]:border-l-0 xl:[&>*:first-child]:pl-0",
].join(" ")

function Lane({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5 border-border">
			<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</span>
			<div className="min-w-0 text-sm">{children}</div>
		</div>
	)
}
