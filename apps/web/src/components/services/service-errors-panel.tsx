import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import type { ErrorIssueDocument, WorkflowState } from "@maple/domain/http"
import { Unitflow, View } from "@maple/unitflow/react"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { SeverityBadge, severityRank } from "@/components/errors/severity-badge"
import { ErrorIssuesModel } from "@/lib/models/error-issues-model"
import { unitflowRuntime } from "@/lib/models/runtime"
import { formatNumber } from "@/lib/format"
import { formatTimeAgo, SectionCard } from "./section-card"

const PANEL_LIMIT = 5

// "Open" for this panel = still needs attention. Resolved/dismissed states are
// what the full issues page is for.
const OPEN_STATES: ReadonlySet<WorkflowState> = new Set(["triage", "todo", "in_progress", "in_review"])

interface ServiceErrorsPanelProps {
	serviceName: string
}

function PanelFrame({ children }: { children: React.ReactNode }) {
	return (
		<SectionCard
			title="Open issues"
			action={
				<Link to="/errors/issues" className="text-xs text-primary hover:underline">
					View all →
				</Link>
			}
		>
			{children}
		</SectionCard>
	)
}

function PanelSkeleton() {
	return (
		<PanelFrame>
			<div className="space-y-px p-2">
				{Array.from({ length: 4 }).map((_, i) => (
					<Skeleton key={i} className="h-8 w-full" />
				))}
			</div>
		</PanelFrame>
	)
}

function PanelMessage({ children }: { children: React.ReactNode }) {
	return <div className="px-4 py-6 text-center text-xs text-muted-foreground">{children}</div>
}

function IssueLine({ issue }: { issue: ErrorIssueDocument }) {
	const title = issue.errorLabel || issue.exceptionType || issue.exceptionMessage || "Unknown error"
	return (
		<Link
			to="/errors/issues/$issueId"
			params={{ issueId: issue.id }}
			className="flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
		>
			<SeverityBadge severity={issue.severity} className="w-[60px] shrink-0 justify-center" />
			<span className="min-w-0 flex-1 truncate" title={title}>
				{title}
			</span>
			<span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
				{formatNumber(issue.occurrenceCount)}×
			</span>
			<span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground/70">
				{formatTimeAgo(issue.lastSeenAt)}
			</span>
		</Link>
	)
}

const PanelBody = View.make(ErrorIssuesModel, ({ overview }, props: ServiceErrorsPanelProps) => {
	if (overview.phase === "loading") return <PanelSkeleton />
	if (overview.phase === "error") {
		return (
			<PanelFrame>
				<PanelMessage>Issues could not be loaded.</PanelMessage>
			</PanelFrame>
		)
	}
	return <PanelReady issues={overview.issues} serviceName={props.serviceName} />
})

function PanelReady({
	issues,
	serviceName,
}: {
	issues: ReadonlyArray<ErrorIssueDocument>
	serviceName: string
}) {
	// The derived list arrives newest-seen-first; keep that as the tiebreaker and
	// bubble the worst severities up so the panel reads as "most urgent first".
	const serviceIssues = useMemo(
		() =>
			issues
				.filter((issue) => issue.serviceName === serviceName && OPEN_STATES.has(issue.workflowState))
				.toSorted((a, b) => severityRank(a.severity) - severityRank(b.severity))
				.slice(0, PANEL_LIMIT),
		[issues, serviceName],
	)

	return (
		<PanelFrame>
			{serviceIssues.length === 0 ? (
				<PanelMessage>No open issues for this service.</PanelMessage>
			) : (
				<div className="space-y-px p-2">
					{serviceIssues.map((issue) => (
						<IssueLine key={issue.id} issue={issue} />
					))}
				</div>
			)}
		</PanelFrame>
	)
}

export function ServiceErrorsPanel({ serviceName }: ServiceErrorsPanelProps) {
	return (
		<Unitflow
			runtime={unitflowRuntime}
			rootModel={ErrorIssuesModel}
			building={<PanelSkeleton />}
			failed={() => (
				<PanelFrame>
					<PanelMessage>Issues could not be loaded.</PanelMessage>
				</PanelFrame>
			)}
		>
			{(unit) => <PanelBody unit={unit} serviceName={serviceName} />}
		</Unitflow>
	)
}
