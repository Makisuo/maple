import type { ErrorIssueId } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { DetailRail } from "@maple/ui/components/detail-rail"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { PulseIcon } from "@/components/icons"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { TimeRangeHeaderControls } from "@/components/time-range-picker/time-range-header-controls"
import type { TimeRange } from "@/components/time-range-picker/types"

import { IssueTabs, type IssueTab } from "./issue-tabs"

/**
 * The issue page before its detail query lands.
 *
 * Not a page of grey bars: everything this page already knows without the
 * server — the layout, the tabs, the time-range control, the rail's row labels,
 * the section headings — is drawn for real, and only the values are ghosted. So
 * the chrome never moves when the data arrives, the tab strip and the window
 * picker are usable during the load, and the reader can see what shape of thing
 * is coming rather than three stacked rectangles.
 */
export function IssueDetailSkeleton({
	issueId,
	tab,
	search,
	onTimeChange,
	windowLabel,
}: {
	issueId: ErrorIssueId
	tab: IssueTab
	search: { startTime?: string; endTime?: string; timePreset?: string }
	onTimeChange: (range: TimeRange) => void
	/** Names the fact strip's window lane, exactly as the loaded page does. */
	windowLabel: string
}) {
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Errors", href: "/errors" }, { label: "…" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Sticky>
						<DashboardLayout.Header
							titleContent={
								<div className="min-w-0 space-y-2.5">
									<Skeleton className="h-3 w-32" />
									{/* Title height, so the strip below it doesn't jump a line
									    when a two-word exception type replaces it. */}
									<Skeleton className="h-7 w-[min(28rem,80%)]" />
									<div className="flex items-center gap-2">
										<Skeleton className="h-5 w-16 rounded-full" />
										<Skeleton className="h-5 w-24 rounded-full" />
									</div>
								</div>
							}
						>
							<div className="flex items-center gap-2">
								<TimeRangeHeaderControls
									startTime={search.startTime}
									endTime={search.endTime}
									presetValue={search.timePreset ?? (search.startTime ? undefined : "12h")}
									onTimeChange={onTimeChange}
								/>
								{/* Present but inert: the action it starts needs the issue it is
								    still fetching, and removing it would shift the whole row. */}
								<Button size="sm" disabled>
									<PulseIcon className="size-3.5" />
									Investigate
								</Button>
							</div>
						</DashboardLayout.Header>
						{/* Counts are the only unknown here, and they are optional — the
						    strip is a real, clickable tab bar while the page loads. */}
						<IssueTabs issueId={issueId} active={tab} showOccurrences />
					</DashboardLayout.Sticky>
					<DashboardLayout.Scroll>
						{tab === "overview" ? (
							<OverviewSkeleton windowLabel={windowLabel} />
						) : (
							<ListSkeleton />
						)}
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
				<DashboardLayout.RightPanel>
					<RailSkeleton />
				</DashboardLayout.RightPanel>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function OverviewSkeleton({ windowLabel }: { windowLabel: string }) {
	return (
		<div className="flex flex-col gap-7">
			{/* `IssueCulpritPanel`: accent rule, message, then the culprit field. */}
			<div className="flex shrink-0 overflow-hidden rounded-r-xl border bg-card">
				<span aria-hidden className="w-[3px] shrink-0 bg-border" />
				<div className="flex min-w-0 flex-1 flex-col gap-4 px-6 py-5">
					<div className="flex flex-col gap-2">
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-3/5" />
					</div>
					<Field label="Culprit">
						<Skeleton className="h-4 w-[min(24rem,70%)]" />
					</Field>
					<Field label="Fingerprint">
						<Skeleton className="h-4 w-48" />
					</Field>
				</div>
			</div>

			{/* `IssueFactStrip`, lane labels and all — only the numbers are unknown. */}
			<div className="grid shrink-0 grid-cols-2 gap-y-5 px-1 xl:grid-cols-4 [&>*]:border-l [&>*]:pl-6 [&>*:nth-child(odd)]:border-l-0 [&>*:nth-child(odd)]:pl-0 xl:[&>*:nth-child(odd)]:border-l xl:[&>*:nth-child(odd)]:pl-6 xl:[&>*:first-child]:border-l-0 xl:[&>*:first-child]:pl-0">
				<Lane label={`Events · ${windowLabel}`} width="w-12" />
				<Lane label="Events · all time" width="w-14" />
				<Lane label="First seen" width="w-24" />
				<Lane label="Last seen" width="w-20" />
			</div>

			{/* `IssueOccurrencePanel`. The heading is the real one; the plot is the
			    chart's own `h-44`, so nothing reflows when the bars arrive. */}
			<section className="flex shrink-0 flex-col gap-3.5 rounded-xl border bg-card px-5 py-4">
				<div className="flex items-baseline gap-2.5">
					<h2 className="font-display text-base font-semibold tracking-[-0.01em] text-foreground">
						Occurrences
					</h2>
					<Skeleton className="h-3.5 w-28" />
				</div>
				<Skeleton className="h-44 w-full rounded-md" />
			</section>
		</div>
	)
}

/** The occurrences and activity tabs are both a heading over a stack of rows. */
function ListSkeleton() {
	return (
		<section className="flex shrink-0 flex-col gap-3.5">
			<Skeleton className="h-5 w-40" />
			<div className="flex flex-col gap-2.5">
				{Array.from({ length: 6 }, (_, index) => (
					<Skeleton key={index} className="h-11 w-full rounded-lg" />
				))}
			</div>
		</section>
	)
}

function RailSkeleton() {
	return (
		<div className="flex flex-col bg-card/30">
			<DetailRail.Group label="Details">
				<RailRow label="Status" width="w-24" />
				<RailRow label="Severity" width="w-16" />
				<RailRow label="Priority" width="w-20" />
				<RailRow label="Assignee" width="w-24" />
			</DetailRail.Group>
			<DetailRail.Group label="Scope">
				<RailRow label="Service" width="w-28" />
				<RailRow label="Environment" width="w-20" />
				<RailRow label="Issue ID" width="w-16" />
			</DetailRail.Group>
		</div>
	)
}

function RailRow({ label, width }: { label: string; width: string }) {
	return (
		<DetailRail.Row label={label}>
			<Skeleton className={`h-4 ${width}`} />
		</DetailRail.Row>
	)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5 border-t pt-3.5 first:border-t-0 first:pt-0">
			<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</span>
			{children}
		</div>
	)
}

function Lane({ label, width }: { label: string; width: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5 border-border">
			<span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
				{label}
			</span>
			<div className="flex min-w-0 items-center text-sm">
				<Skeleton className={`h-4 ${width}`} />
			</div>
		</div>
	)
}
